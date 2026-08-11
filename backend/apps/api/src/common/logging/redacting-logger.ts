import { ConsoleLogger, type LoggerService } from "@nestjs/common";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN = /(phone|address|token|authorization|cookie)/i;
const E164_VALUE_PATTERN = /\+[1-9]\d{7,14}\b/g;

function redactString(value: string) {
  return value.replace(E164_VALUE_PATTERN, REDACTED);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(entry, seen),
    ]),
  );
}

export function redactLogRecord<T>(record: T): T {
  return redactValue(record, new WeakSet<object>()) as T;
}

export function createRedactingLogger(
  logger: LoggerService = new ConsoleLogger(),
): LoggerService {
  const redactParams = (params: unknown[]) => params.map((param) => redactLogRecord(param));

  return {
    log(message: unknown, ...optionalParams: unknown[]) {
      logger.log(redactLogRecord(message), ...redactParams(optionalParams));
    },
    error(message: unknown, ...optionalParams: unknown[]) {
      logger.error(redactLogRecord(message), ...redactParams(optionalParams));
    },
    warn(message: unknown, ...optionalParams: unknown[]) {
      logger.warn(redactLogRecord(message), ...redactParams(optionalParams));
    },
    debug(message: unknown, ...optionalParams: unknown[]) {
      logger.debug?.(redactLogRecord(message), ...redactParams(optionalParams));
    },
    verbose(message: unknown, ...optionalParams: unknown[]) {
      logger.verbose?.(redactLogRecord(message), ...redactParams(optionalParams));
    },
    fatal(message: unknown, ...optionalParams: unknown[]) {
      logger.fatal?.(redactLogRecord(message), ...redactParams(optionalParams));
    },
  };
}
