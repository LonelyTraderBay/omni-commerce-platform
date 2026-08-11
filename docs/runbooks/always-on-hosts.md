# E1 — Always-on hosts (web + api + ai)

## Mục tiêu

Cold start = 0 trên critical path webhook Meta → api → (jobs) → ai.

## Checklist Render / Fly

1. [ ] `backend/apps/api` paid/always-on (no free sleep)
2. [ ] `backend/apps/ai` paid/always-on
3. [ ] `frontend/apps/web` paid/always-on (hoặc CDN + origin always-on)
4. [ ] Health: `/health` api, `/health` ai, web `/`  
5. [ ] Meta webhook URL trỏ api always-on  
6. [ ] Inngest endpoint reachable từ cloud  

## Verify no sleep miss

```bash
# From external network, every 1–2 min for 30 min during idle
curl -sS -o /dev /null -w "%{http_code} %{time_total}\n" https://<api>/health
```

Expect: stable 200, no multi-second cold spikes after idle.

## Status

| Field | Value |
|-------|-------|
| Provider | Render (ADR 0001) |
| Always-on applied | **NOT RUN** — requires paid account |
| Webhook URL | |
| Notes | Until then use tunnel + keep-warm only for review (not production claim) |
