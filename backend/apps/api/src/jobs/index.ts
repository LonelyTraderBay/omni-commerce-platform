export { inngest } from "./inngest.client";
export { knowledgeReindex } from "./functions/knowledge-reindex";
export { metaPersistInbound } from "./functions/meta-persist-inbound";
export { zaloPersistInbound } from "./functions/zalo-persist-inbound";
export { metaSend } from "./functions/meta-send";
export { orderWebhookDispatch } from "./functions/order-webhook-dispatch";
export { platformNoop } from "./functions/platform-noop";
export { processInboundMessage } from "./functions/process-inbound-message";
export { OutboxPublisher, enqueueOutbox } from "./outbox.publisher";
import { knowledgeReindex } from "./functions/knowledge-reindex";
import { metaPersistInbound } from "./functions/meta-persist-inbound";
import { zaloPersistInbound } from "./functions/zalo-persist-inbound";
import { metaSend } from "./functions/meta-send";
import { orderWebhookDispatch } from "./functions/order-webhook-dispatch";
import { platformNoop } from "./functions/platform-noop";
import { processInboundMessage } from "./functions/process-inbound-message";

export const inngestFunctions = [
  platformNoop,
  metaPersistInbound,
  zaloPersistInbound,
  processInboundMessage,
  metaSend,
  knowledgeReindex,
  orderWebhookDispatch,
];
