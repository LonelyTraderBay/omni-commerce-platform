import { Injectable } from "@nestjs/common";

import { loadEnv } from "../../config/env";

@Injectable()
export class AiProxyService {
  async checkAiHealth(traceparent?: string) {
    const env = loadEnv();
    const res = await fetch(`${env.AI_BASE_URL}/health`, {
      headers: {
        "X-Service-Key": env.SERVICE_M2M_KEY,
        ...(traceparent ? { traceparent } : {}),
      },
    });

    return res.json();
  }
}
