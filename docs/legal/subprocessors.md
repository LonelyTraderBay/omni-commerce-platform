# Danh sách subprocessors (nội bộ)

**Cập nhật:** 2026-07-25  
**Phạm vi:** pilot Omni Commerce AI SaaS  
**Công khai:** `/legal/subprocessors` (Plan I / M4.5) — dùng nội bộ + đính kèm DPA.

| Nhà cung cấp | Mục đích | Dữ liệu liên quan | Vùng (điển hình) |
|--------------|----------|-------------------|------------------|
| Supabase | Postgres, Auth, Storage | Dữ liệu ứng dụng đa thuê bao | Theo project (ghi rõ khi provision) |
| Render **hoặc** Fly.io | Host web / api / ai | Traffic HTTP, logs | Theo region deploy |
| Inngest | Jobs / webhooks async | Payload sự kiện (org-scoped) | Theo Inngest account |
| Google (Gemini) | LLM + embeddings | Prompt/context có thể chứa PII tin nhắn | Google Cloud AI |
| Meta Platforms | Messenger / Instagram messaging | Webhook nội dung tin, page tokens (mã hóa at rest trên Core) | Meta |
| Sentry (nếu bật) | Error tracking | Stack traces, request metadata | Theo Sentry org |
| Uptime monitor (UptimeRobot / Better Stack) | Health checks | URL public, status | Theo vendor |

## Ghi chú

- Token Meta: AES-256-GCM trên Core; không gửi browser.  
- LLM: Core ghi `ai_runs`; kill switches `kill_ai_all` / `kill_ai_outbound`.  
- Thêm/bớt subprocessor material → cập nhật file này + thông báo khách pilot theo [runbook thông báo](../runbooks/subprocessors-change-notify.md) (eng process ready; legal/owner approve vẫn AMBER).

## Liên kết

- [DPA mẫu](./dpa-template.md)  
- [Privacy (app)](../../frontend/apps/web/src/app/legal/privacy/page.tsx)
- [Subprocessors public page](../../frontend/apps/web/src/app/legal/subprocessors/page.tsx)
- [Subprocessors change — customer notification](../runbooks/subprocessors-change-notify.md)
- [PDPA delete runbook](../runbooks/pdpa-delete.md)
