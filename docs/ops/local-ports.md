# Local ports — Omni Commerce (locked)

**SoT:** [`infra/config/local-ports.json`](../../infra/config/local-ports.json)

Dải cổng **cố định** cho repo `omni-commerce-platform` để không trùng dự án khác trên cùng máy (Next mặc định `:3000`, FastAPI `:8000`, Supabase mặc định `:54321`, …).

## Bảng cổng

| Vai trò | Cổng | URL |
|---------|-----:|-----|
| Web (Next) | **4700** | http://127.0.0.1:4700 |
| API (Nest) | **4701** | http://127.0.0.1:4701 |
| AI (FastAPI) | **4702** | http://127.0.0.1:4702 |
| Inngest Dev UI | **4788** | http://127.0.0.1:4788 |
| Supabase API (Kong) | **54721** | http://127.0.0.1:54721 |
| Supabase DB | **54722** | (Postgres) |
| Studio | **54723** | http://127.0.0.1:54723 |
| Mailpit | **54724** | http://127.0.0.1:54724 |
| Analytics | **54727** | — |

## Đồng bộ env

```powershell
pnpm run ports:sync
```

Cập nhật `PORT` / `*_URL` trong `.env`, `frontend/apps/web/.env.local`, `backend/apps/ai/.env`, `.env.example` theo JSON (không đụng secret khác).

## Khởi động / dừng

```powershell
# Lần đầu hoặc sau khi đổi cổng Supabase:
npx supabase stop --workdir backend/database
npx supabase start --workdir backend/database

pnpm run ports:sync
pnpm run dev:local:stop   # dọn cổng Omni + PID cũ
pnpm run dev:local        # fail nếu cổng app bị chiếm
```

`dev:local` đọc `infra/config/local-ports.json`, set `PORT` / URL cho process con, Inngest `-p 4788`.
`dev:local:stop` kill theo PID file **và** theo cổng locked (tránh Inngest orphan).

## Đổi cổng

1. Sửa `infra/config/local-ports.json`
2. Sửa `backend/database/supabase/config.toml` (`[api]`/`[db]`/`[studio]`/`[inbucket]`/`[analytics]`) cho khớp
3. Sửa `frontend/apps/web` `package.json` script `dev -p …` cho khớp (fallback khi không qua `dev:local`)
4. `pnpm run ports:sync`
5. `npx supabase stop --workdir backend/database` → `npx supabase start --workdir backend/database` → `pnpm run dev:local`

## Sự cố thường gặp

### Trang web tự tải lại liên tục, không nhập liệu được

**Triệu chứng:** mọi trang render bình thường nhưng cứ vài giây lại tự reload; `.local-secrets\logs\web.err.log` đầy lỗi lặp `FATAL: An unexpected Turbopack error ... Next.js package not found` (panic trong `hmr_version_state`).

**Nguyên nhân:** cache Turbopack trên đĩa (`frontend/apps/web/.next`) bị hỏng — thường sau khi đổi git branch nhiều lần trong khi dev server đang chạy. Restart server thường **không** chữa được vì cache hỏng nằm trên đĩa.

**Cách sửa:**

```powershell
pnpm run dev:local:stop
pnpm run dev:local:fresh   # = dev:local nhưng xoá frontend/apps/web/.next trước khi start web
```

(Đã gặp và xác minh 2026-07-29: 1.658 panic/40 phút → 0 sau khi xoá cache; trang sống ổn định >100 giây thay vì reload mỗi vài giây.)

## CI

Isolation workflow dùng `SUPABASE_URL=http://127.0.0.1:54721` (khớp `config.toml` khi `supabase start` trên runner).
