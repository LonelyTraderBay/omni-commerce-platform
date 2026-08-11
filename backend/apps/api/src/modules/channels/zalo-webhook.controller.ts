import { Body, Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";

import { ZaloWebhookService } from "./zalo-webhook.service";

type RequestWithRawBody = {
  rawBody?: Buffer;
};

@Controller("v1/channels/zalo/webhook")
export class ZaloWebhookController {
  constructor(private readonly webhooks: ZaloWebhookService) {}

  @Post()
  @HttpCode(200)
  ingest(
    @Headers("x-zalo-webhook-secret") secretHeader: string | undefined,
    @Req() request: RequestWithRawBody,
    @Body() payload: unknown,
  ) {
    return this.webhooks.ingest({
      payload,
      rawBody: Buffer.isBuffer(request.rawBody)
        ? request.rawBody
        : Buffer.from(""),
      secretHeader,
    });
  }
}
