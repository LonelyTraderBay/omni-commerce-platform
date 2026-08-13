# Runbook: AI down

## Triệu chứng

- API gọi `AI_BASE_URL` bị timeout, trả lỗi 5xx, hoặc `/health` của AI không trả `{"status":"ok"}`.
- Tính năng tạo nháp, gợi ý trả lời, hoặc phân tích hội thoại bị treo.
- Log API có lỗi từ `ai-proxy` hoặc kết nối tới `backend/apps/ai`.

## Kiểm tra

1. Gọi health check: `GET /health` trên AI service.
2. Kiểm tra Render service của `backend/apps/ai`: trạng thái deploy, restart loop, CPU/RAM, log gần nhất.
3. Kiểm tra biến môi trường AI: `SERVICE_M2M_KEY`, `CORE_BASE_URL`, `APP_ENV`,
   `AI_PROVIDER`, `AI_MODEL_ALLOWLIST`, `OPENAI_MODEL`, và provider key.
   Staging/production phải có `APP_ENV=production`; local mặc định phải dùng
   `AI_PROVIDER=stub`.
4. Kiểm tra API có trỏ đúng `AI_BASE_URL` và không bị chặn mạng nội bộ.

## Hành động

1. Bật cờ giảm tác động nếu có: `kill_ai_outbound` hoặc `kill_ai_all`.
2. Restart AI service trên Render nếu health check fail do tiến trình treo.
3. Rollback deploy AI gần nhất nếu lỗi bắt đầu sau deploy.
4. Nếu provider LLM lỗi, tạm giới hạn chức năng AI và thông báo nội bộ rằng hệ thống chạy ở chế độ không AI.

## Leo thang

- Leo thang cho owner API/AI nếu downtime quá 15 phút hoặc lỗi ảnh hưởng nhiều tenant.
- Leo thang cho owner bảo mật nếu nghi ngờ lộ key hoặc response AI bất thường do prompt injection.
- Mở incident vận hành nếu cần rollback hoặc thay đổi cờ kill switch trên production.
