import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { ServiceKeyGuard } from "../../common/guards/service-key.guard";
import {
  AiTokenUsageService,
  parseRecordAiTokenUsageBody,
} from "../billing/ai-token-usage.service";

const CheckQuotaSchema = z.object({
  orgId: z.string().uuid(),
});

@Controller("internal/v1/billing")
@UseGuards(ServiceKeyGuard)
export class AiTokenQuotaController {
  constructor(private readonly aiTokenUsage: AiTokenUsageService) {}

  @Post("ai-token-quota/check")
  async checkQuota(@Body() body: unknown) {
    const parsed = CheckQuotaSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          code: "invalid_request",
          message: "Request body is invalid",
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const status = await this.aiTokenUsage.getQuotaStatus(parsed.data.orgId);
    if (status.exceeded) {
      throw new HttpException(
        {
          code: "ai_token_quota_exceeded",
          message: "Monthly AI token quota has been exceeded",
          ...status,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return status;
  }

  @Post("ai-token-quota/record")
  async recordUsage(@Body() body: unknown) {
    await this.aiTokenUsage.recordUsage(parseRecordAiTokenUsageBody(body));
    return { ok: true };
  }
}
