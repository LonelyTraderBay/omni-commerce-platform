# Deploy staging — Render (ADR 0001)

## Project linkage

| App | Render service | Live URL | Supabase |
|-----|----------------|----------|----------|
| `backend/apps/api` | `omni-api-staging` | https://omni-api-staging-cs2w.onrender.com | `tjsmpcgkeoglemptuymu` |
| `backend/apps/ai` | `omni-ai-staging` | https://omni-ai-staging.onrender.com | — |
| `frontend/apps/web` | `omni-web-staging` | https://omni-web-staging.onrender.com | same staging project |

Blueprint file: [`render.yaml`](../../render.yaml) (currently **free** plan — sleeps; upgrade to **starter** when payment added).

## One-shot (Dashboard)

1. Open https://dashboard.render.com/blueprints  
2. **New Blueprint Instance** → connect GitHub repo `LonelyTraderBay/omni-commerce-platform`  
3. Branch `main`, path `render.yaml`  
4. Fill `sync: false` env vars (see below)  
5. **Deploy Blueprint**

## Env values to paste (staging Supabase)

```
SUPABASE_URL=https://tjsmpcgkeoglemptuymu.supabase.co
SUPABASE_ANON_KEY=<from supabase projects api-keys>
SUPABASE_SERVICE_ROLE_KEY=<service_role>
NEXT_PUBLIC_SUPABASE_URL=https://tjsmpcgkeoglemptuymu.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon>
META_APP_ID=<your meta app>
META_APP_SECRET=<secret>
META_VERIFY_TOKEN=<8+ chars>
META_REDIRECT_URI=https://omni-web-staging.onrender.com/settings/channels/callback
NEXT_PUBLIC_API_BASE_URL=https://omni-api-staging-cs2w.onrender.com
```

`TOKEN_ENCRYPTION_KEY` / `SERVICE_M2M_KEY` set via Render API (also in local `.local-secrets/`).

## CLI / CI (API key)

```bash
# https://dashboard.render.com/u/settings#api-keys
export RENDER_API_KEY=rnd_...
# Then open Blueprint in dashboard once (CLI cannot create Blueprint from YAML without dashboard link yet for first time).
# Subsequent deploys:
render deploys create <SERVICE_ID> --confirm
```

GitHub secret optional: `RENDER_API_KEY` for workflow re-deploys.

## Verify

```bash
curl -sS https://<api>/health
curl -sS https://<ai>/health
curl -sS -o /dev/null -w "%{http_code}\n" https://<web>/
```

## Status

| Field | Value |
|-------|-------|
| Blueprint committed | YES — `render.yaml` |
| Live services | **LIVE (free)** — api/ai/web; API Nest started on Node 22 (`49cc493`) |
| Supabase staging | `tjsmpcgkeoglemptuymu` migrated |

## Troubleshoot "URL không lên"

1. **Free tier cold start**: lần đầu sau ~15 phút idle, Render hiện trang *Application loading* 30–90s — đợi rồi F5.
2. **Mạng local chặn onrender.com**: nếu browser/curl TLS reset, thử 4G hotspot hoặc VPN; agent máy local cũng bị reset trong khi probe quốc tế vẫn 200.
3. **Keep-warm**: workflow `.github/workflows/staging-keep-warm.yml` ping mỗi 10 phút (giảm sleep, không thay starter).
4. **Always-on thật**: thêm payment trên Render → đổi plan `free` → `starter`.

## Verified (external probe 2026-07-25)

| URL | Result |
|-----|--------|
| https://omni-api-staging-cs2w.onrender.com/health | `{"status":"ok"}` |
| https://omni-ai-staging.onrender.com/health | `{"status":"ok"}` (sau wake) |
| https://omni-web-staging.onrender.com/ | landing Omni Commerce (sau wake) |

## Upgrade to always-on (owner)

**Runbook tiếng Việt (B1):** [b1-render-starter-owner.md](./b1-render-starter-owner.md) · SDD: [2026-07-27-sdd-b1-render-starter.md](../superpowers/plans/2026-07-27-sdd-b1-render-starter.md)

**Prerequisite:** Owner billing only — agent must not add payment methods.

| # | Action | Detail |
|---|--------|--------|
| 1 | Add payment method | https://dashboard.render.com/u/billing → **Add payment method** |
| 2 | Upgrade `omni-api-staging` | https://dashboard.render.com/web/srv-d9i2sjbeo5us7394purg → **Settings** → **Instance Type** → **Free** → **Starter** → **Save** |
| 3 | Upgrade `omni-ai-staging` | https://dashboard.render.com/web/srv-d9i2skbrjlhs73e95lsg → same (Free → Starter) |
| 4 | Upgrade `omni-web-staging` | https://dashboard.render.com/web/srv-d9i2sl3h2c0s73823lqg → same (Free → Starter) |
| 5 | (Optional) Sync blueprint | In `render.yaml`, change `plan: free` → `plan: starter` for all three services; commit so future Blueprint deploys match |
| 6 | Verify always-on (post-upgrade) | From **external** network **after** steps 2–4: `curl` all three URLs (see **Verify** above) — stable HTTP 200 with no 30–90s cold-start page on critical path (api `/health`, ai `/health`, web `/`). Re-probe after 15–30 min idle if possible |
| 7 | Update evidence | **GREEN** only when steps 2–4 complete **and** step 6 post-upgrade no-cold-start proof is recorded. Keep-warm `healthy_count=3/3` supports **AMBER** reachability on free tier only — **not** sufficient for GREEN |

**Live URLs (unchanged after upgrade):**

| Service | URL |
|---------|-----|
| `omni-api-staging` | https://omni-api-staging-cs2w.onrender.com |
| `omni-ai-staging` | https://omni-ai-staging.onrender.com |
| `omni-web-staging` | https://omni-web-staging.onrender.com |

Keep-warm workflow (`.github/workflows/staging-keep-warm.yml`) can stay enabled to support **AMBER** reachability on free tier but is **not** a substitute for Starter always-on and **cannot** alone justify R0.2 GREEN.
