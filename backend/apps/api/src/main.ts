import "./instrument";
import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module";
import { ProblemDetailsFilter } from "./common/filters/problem-details.filter";
import { createRedactingLogger } from "./common/logging/redacting-logger";
import { idempotencyMiddleware } from "./common/middleware/idempotency.middleware";
import { rateLimitMiddleware } from "./common/rate-limit/rate-limit.middleware";
import { requestIdMiddleware } from "./common/middleware/request-id.middleware";
import { securityHeadersMiddleware } from "./common/middleware/security-headers.middleware";
import { traceparentMiddleware } from "./common/middleware/traceparent.middleware";
import { buildCorsOptions } from "./config/cors";
import { loadEnv } from "./config/env";

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    logger: createRedactingLogger(),
    rawBody: true,
  });

  app.enableShutdownHooks();
  app.enableCors(buildCorsOptions(env));
  app.use(requestIdMiddleware);
  app.use(rateLimitMiddleware);
  app.use(traceparentMiddleware);
  app.use(securityHeadersMiddleware);
  app.use(idempotencyMiddleware);
  app.useGlobalFilters(new ProblemDetailsFilter());

  await app.listen(env.PORT, "0.0.0.0");
}

void bootstrap();
