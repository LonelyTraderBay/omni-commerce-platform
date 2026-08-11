import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
} from "@nestjs/common";

import { MetaWebhookService } from "./meta-webhook.service";

type RequestWithRawBody = {
  rawBody?: Buffer;
};

@Controller("v1/webhooks/meta")
export class MetaWebhookController {
  constructor(private readonly webhooks: MetaWebhookService) {}

  @Get()
  @Header("Content-Type", "text/plain")
  verify(
    @Query("hub.mode") mode: string | undefined,
    @Query("hub.verify_token") verifyToken: string | undefined,
    @Query("hub.challenge") challenge: string | undefined,
  ) {
    return this.webhooks.verifySubscription({
      challenge,
      mode,
      verifyToken,
    });
  }

  @Post()
  @HttpCode(200)
  ingest(
    @Headers("x-hub-signature-256") signatureHeader: string | undefined,
    @Req() request: RequestWithRawBody,
    @Body() payload: unknown,
  ) {
    return this.webhooks.ingest({
      payload,
      rawBody: Buffer.isBuffer(request.rawBody)
        ? request.rawBody
        : Buffer.from(""),
      signatureHeader,
    });
  }
}
