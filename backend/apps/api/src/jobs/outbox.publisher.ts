import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnv } from "../config/env";
import { inngest } from "./inngest.client";

export const OUTBOX_SUPABASE = Symbol("OUTBOX_SUPABASE");
export const OUTBOX_INNGEST = Symbol("OUTBOX_INNGEST");
export const OUTBOX_PUBLISHER_OPTIONS = Symbol("OUTBOX_PUBLISHER_OPTIONS");

const OUTBOX_SELECT =
  "id, org_id, event_name, payload_json, created_at, published_at, attempts, next_attempt_at";
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PUBLISH_INTERVAL_MS = 2_000;

/**
 * Delay applied after the Nth consecutive failed send, indexed by attempt
 * number (1-based). Chosen so the default 5-attempt budget spans ~12m40s of
 * continuous outage instead of the ~8s it took when every tick burned an
 * attempt. The last entry is reused if `maxAttempts` is raised.
 */
const BACKOFF_SCHEDULE_MS = [2_000, 8_000, 30_000, 120_000, 600_000];

export type SupabaseLike = Pick<SupabaseClient, "from">;
export type JsonObject = Record<string, unknown>;

export type EnqueueOutboxInput = {
  orgId: string;
  eventName: string;
  payload: JsonObject;
};

export type InngestSender = {
  /**
   * `id` is Inngest's idempotency key: "A unique id used to idempotently
   * process a given event payload. Set this when sending events to ensure that
   * the event is only processed once; if an event with the same ID is sent
   * again, it will not invoke functions." (inngest@4.13.0, MinimalEventPayload)
   */
  send(event: {
    id: string;
    name: string;
    data: JsonObject;
  }): Promise<unknown>;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

type OutboxRow = {
  id: string;
  org_id: string;
  event_name: string;
  payload_json: JsonObject | null;
  created_at: string;
  published_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
};

type OutboxPublisherOptions = {
  maxAttempts?: number;
  now?: () => Date;
  publishIntervalMs?: number;
};

export async function enqueueOutbox(
  tx: SupabaseLike,
  input: EnqueueOutboxInput,
) {
  const { data, error } = await tx
    .from("outbox_events")
    .insert({
      org_id: input.orgId,
      event_name: input.eventName,
      payload_json: input.payload,
      published_at: null,
      attempts: 0,
    })
    .select(OUTBOX_SELECT)
    .single();

  if (error) {
    throwOutboxError(error, "Could not enqueue outbox event");
  }

  return mapOutboxRow(data as OutboxRow);
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly supabase: SupabaseLike;
  private readonly inngestClient: InngestSender;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly publishIntervalMs: number;
  private publishTimer: ReturnType<typeof setInterval> | undefined;
  private isPublishing = false;

  constructor(
    @Optional()
    @Inject(OUTBOX_SUPABASE)
    supabase?: SupabaseLike,
    @Optional()
    @Inject(OUTBOX_INNGEST)
    inngestClient?: InngestSender,
    @Optional()
    @Inject(OUTBOX_PUBLISHER_OPTIONS)
    options: OutboxPublisherOptions = {},
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
    this.inngestClient = inngestClient ?? inngest;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.now = options.now ?? (() => new Date());
    this.publishIntervalMs =
      options.publishIntervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS;
  }

  onModuleInit() {
    if (process.env.NODE_ENV === "test" || this.publishTimer) {
      return;
    }

    this.publishTimer = setInterval(() => {
      void this.publishPendingOnce();
    }, this.publishIntervalMs);

    const timer = this.publishTimer as { unref?: () => void };
    timer.unref?.();
  }

  onModuleDestroy() {
    if (!this.publishTimer) {
      return;
    }

    clearInterval(this.publishTimer);
    this.publishTimer = undefined;
  }

  async publishPending(batchSize = DEFAULT_BATCH_SIZE) {
    const { data, error } = await this.supabase
      .from("outbox_events")
      .select(OUTBOX_SELECT)
      .is("published_at", null)
      .lt("attempts", this.maxAttempts)
      .or(
        `next_attempt_at.is.null,next_attempt_at.lte.${this.now().toISOString()}`,
      )
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (error) {
      throwOutboxError(error, "Could not read pending outbox events");
    }

    const rows = (data ?? []) as OutboxRow[];
    let published = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const row of rows) {
      try {
        // Only the send itself may count as a delivery failure. `id` is the
        // Inngest idempotency key, so a redelivery of a row we already sent
        // (crash or bookkeeping failure below) will not invoke the function a
        // second time.
        await this.inngestClient.send({
          id: row.id,
          name: toInngestEventName(row.event_name),
          data: {
            ...(row.payload_json ?? {}),
            orgId: row.org_id,
            outboxEventId: row.id,
          },
        });
      } catch (sendError) {
        deadLettered += await this.recordFailedSend(row, sendError);
        failed += 1;
        continue;
      }

      published += 1;

      // The event IS delivered at this point. A failure here is bookkeeping
      // only: never bump attempts and never dead-letter, or a delivered event
      // gets permanently mislabelled as failed. The row simply stays
      // unpublished and is re-sent (harmlessly, see the dedup `id` above).
      try {
        await this.markPublished(row.id, this.now().toISOString());
      } catch (bookkeepingError) {
        this.logger.error(
          `Outbox event ${row.id} was delivered to Inngest but could not be marked published; it will be re-sent and deduplicated by event id`,
          bookkeepingError instanceof Error
            ? bookkeepingError.stack
            : String(bookkeepingError),
        );
      }
    }

    return { published, failed, deadLettered };
  }

  /**
   * Persists the outcome of a genuinely failed send. Returns the number of
   * dead letters written (0 or 1).
   *
   * Ordering is load-bearing: bumping `attempts` to `maxAttempts` is what
   * removes the row from every future pending scan, so the dead-letter row —
   * the only remaining artifact of the event — must exist *before* that
   * happens. If the dead-letter insert fails we deliberately leave `attempts`
   * below the cap so the row stays selectable and can be dead-lettered on a
   * later tick, rather than vanishing with no artifact at all.
   */
  private async recordFailedSend(row: OutboxRow, sendError: unknown) {
    const nextAttempts = row.attempts + 1;
    const isExhausted = nextAttempts >= this.maxAttempts;
    let deadLettered = 0;

    if (isExhausted) {
      try {
        await this.writeDeadLetter(row, nextAttempts, sendError);
        deadLettered = 1;
      } catch (deadLetterError) {
        this.logger.error(
          `Could not write dead letter for outbox event ${row.id}; keeping attempts below the cap so the event stays retryable`,
          deadLetterError instanceof Error
            ? deadLetterError.stack
            : String(deadLetterError),
        );
      }
    }

    const attemptsToPersist =
      isExhausted && deadLettered === 0 ? row.attempts : nextAttempts;

    // Back off regardless, so a row we could not dead-letter does not hot-loop.
    await this.markFailed(
      row.id,
      attemptsToPersist,
      this.nextAttemptAt(nextAttempts),
    );

    return deadLettered;
  }

  private nextAttemptAt(attempts: number) {
    const index = Math.min(
      Math.max(attempts, 1),
      BACKOFF_SCHEDULE_MS.length,
    ) - 1;
    const delayMs = BACKOFF_SCHEDULE_MS[index] as number;
    return new Date(this.now().getTime() + delayMs).toISOString();
  }

  private async publishPendingOnce() {
    if (this.isPublishing) {
      return;
    }

    this.isPublishing = true;
    try {
      await this.publishPending();
    } catch (error) {
      this.logger.error(
        "Outbox publish interval failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isPublishing = false;
    }
  }

  private async markPublished(id: string, publishedAt: string) {
    const { error } = await this.supabase
      .from("outbox_events")
      .update({ published_at: publishedAt })
      .eq("id", id)
      .is("published_at", null)
      .select("id")
      .maybeSingle();

    if (error) {
      throwOutboxError(error, "Could not mark outbox event published");
    }
  }

  private async markFailed(
    id: string,
    attempts: number,
    nextAttemptAt: string,
  ) {
    const { error } = await this.supabase
      .from("outbox_events")
      .update({ attempts, next_attempt_at: nextAttemptAt })
      .eq("id", id)
      .is("published_at", null)
      .select("id")
      .maybeSingle();

    if (error) {
      throwOutboxError(error, "Could not update outbox attempts");
    }
  }

  private async writeDeadLetter(
    row: OutboxRow,
    attempts: number,
    error: unknown,
  ) {
    const { error: insertError } = await this.supabase
      .from("job_dead_letters")
      .insert({
        job_name: row.event_name,
        payload_json: {
          orgId: row.org_id,
          outboxEventId: row.id,
          payload: row.payload_json ?? {},
        },
        error_text: errorToText(error),
        attempts,
      })
      .select("id")
      .single();

    if (insertError) {
      throwOutboxError(insertError, "Could not write outbox dead letter");
    }
  }
}

function mapOutboxRow(row: OutboxRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    eventName: row.event_name,
    payload: row.payload_json ?? {},
    createdAt: row.created_at,
    publishedAt: row.published_at,
    attempts: row.attempts,
  };
}

function toInngestEventName(eventName: string) {
  if (eventName === "knowledge.reindex") {
    return "knowledge/reindex";
  }
  if (eventName === "meta.inbound") {
    return "meta/persist_inbound";
  }
  if (eventName === "ai.process_inbound") {
    return "ai/process_inbound";
  }
  if (eventName === "meta.send") {
    return "meta/send";
  }
  if (eventName.startsWith("order.")) {
    return "order/webhook_dispatch";
  }

  return eventName.replaceAll(".", "/");
}

function errorToText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function throwOutboxError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: "outbox_failed",
    message,
  });
}

function createSupabaseServiceClient() {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
