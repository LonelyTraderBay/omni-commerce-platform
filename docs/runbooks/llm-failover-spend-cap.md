# E2 — LLM spend cap + secondary provider

## Platform spend cap (vendor bill)

Env (AI service):

- `LLM_DAILY_SPEND_CAP_USD` — soft/hard daily  
- `LLM_MONTHLY_SPEND_CAP_USD` — monthly  
- Tracking: approximate from token usage × unit cost table in config  
- `GEMINI_USD_PER_1K_EMBEDDING_TOKENS` — embeddings bill input tokens only  

Khi vượt: process-message escalate / 429; không gọi Gemini.

Metered paths (tất cả đều `record_*` vào counter + báo usage về Core):

- `process-message` completion — `ref_type=completion`  
- `process-message` embedding — `ref_type=embedding` (gate chạy TRƯỚC khi embed)  
- `/reindex` embedding — `ref_type=embedding_reindex`, đo theo **batch** (1 estimate/1 record cho cả request), vượt cap → HTTP 429, không embed  
- `/ai/advise` completion — `ref_type=advisor`, vượt cap/quota → trả stub, không gọi LLM  

⚠️ Counter là file JSON **per-process** (`LLM_SPEND_COUNTER_PATH`) khoá bằng `threading.Lock`.
Nhiều uvicorn worker ⇒ cap thực tế là per-worker. Muốn cap toàn cục phải chuyển counter sang DB/Redis.

## Per-org quota (đã có)

`entitlements.ai_monthly_token_limit` + `AiTokenUsageService` — tách biệt với cap vendor.

## Secondary provider

- Primary: Gemini (`GeminiLlmProvider`)  
- Secondary: OpenAI (`OpenAiLlmProvider`) khi `OPENAI_API_KEY` được set và primary **down**  
- `/ai/advise` dùng cùng provider factory với `process-message`; `AI_PROVIDER=openai`
  chọn OpenAI trực tiếp, còn staging mặc định dùng Gemini primary và OpenAI fallback.

Failover: thử secondary một lần; nếu cả hai fail → escalate.

Allowlist khi failover:

- OpenAI resolve model theo `GEMINI_TO_OPENAI_FALLBACK` (gemini-*-flash → `gpt-4o-mini`, gemini-*-pro → `gpt-4o`); model lạ → `OPENAI_MODEL`.  
- Model **đã resolve** mới là model được allowlist-check và gửi đi ⇒ phải thêm nó vào `AI_MODEL_ALLOWLIST` trước khi failover được phép tiêu tiền.  
- Primary từ chối vì allowlist (`ModelNotAllowedError`) **không** kích hoạt failover — fail closed, trả 400.  
- Primary down + fallback model chưa allowlist → `RuntimeError` → HTTP 502 (lỗi cấu hình, không phải lỗi client).

## Prove cap

1. Set daily cap rất thấp trên staging  
2. Gửi vài process-message  
3. Expect escalate / reject trước khi gọi LLM tiếp  

## Status

Code path shipped in Plan E implementation; live prove on staging = operator.
