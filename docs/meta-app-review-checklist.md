# Meta App Review + staging pilot checklist

Checklist for submitting Omni Commerce Phase 1 (Facebook Page + Instagram DM inbox) to Meta App Review and running a controlled pilot on staging.

**Code reference:** OAuth scopes in `backend/apps/api/src/modules/channels/channels.service.ts`; webhook at `/v1/webhooks/meta`.

---

## 1. Before you submit

| Item | Done | Notes |
|------|:----:|-------|
| Meta App type = **Business** | ☐ | [developers.facebook.com](https://developers.facebook.com) |
| Products added: **Facebook Login**, **Messenger**, **Instagram** | ☐ | Instagram messaging requires IG Professional linked to Page |
| App switched to **Live** mode only after review (keep **Development** until approved) | ☐ | |
| Business verification complete (if Meta prompts) | ☐ | Business Manager + verified domain helps |
| Dedicated **staging** Meta App *or* separate env vars on same app with staging URLs | ☐ | Prefer staging app for dev; production app for review |
| API host always-on (no cold-start webhook drops) | ☐ | See [ADR 0001](./adr/0001-host-vendor-render.md) |
| `META_*` secrets set on API only — never `NEXT_PUBLIC_*` | ☐ | `.env.example` |

---

## 2. Permissions to request (Phase 1)

Request **Advanced Access** for each permission used in OAuth. Confirm names against [Meta permissions reference](https://developers.facebook.com/docs/permissions/reference) before submit — Meta renames occasionally.

| Permission | Why Omni needs it |
|------------|-------------------|
| `pages_show_list` | List Pages the shop admin manages during connect |
| `pages_messaging` | Receive and send Messenger DMs for connected Page |
| `pages_read_engagement` | Page metadata / engagement context for channel setup |
| `instagram_basic` | Resolve IG Business account linked to Page |
| `instagram_manage_messages` | Receive and send Instagram DMs |

**Use case text (English, for review form):**

> Omni Commerce is a B2B SaaS inbox for Vietnamese shops. A shop owner connects their Facebook Page and linked Instagram Professional account so customer DMs appear in one dashboard. Staff can view conversations, take over from AI, and create orders. We only access Pages/IG accounts the user explicitly selects during OAuth. Messages are stored encrypted-at-rest page tokens; used solely to sync inbox and reply on behalf of the connected business.

**Do not request** permissions Omni does not use (ads, publishing, user friends, etc.) — extra scopes slow or fail review.

---

## 3. Privacy Policy & Terms URLs

Meta requires **public HTTPS** URLs that load without login.

| URL (production example) | Route in repo |
|--------------------------|---------------|
| `https://<app-host>/legal/privacy` | `frontend/apps/web/src/app/legal/privacy/page.tsx` |
| `https://<app-host>/legal/terms` | `frontend/apps/web/src/app/legal/terms/page.tsx` |

| Item | Done | Notes |
|------|:----:|-------|
| URLs reachable from Meta reviewer browser | ☐ | No auth wall, no 404 |
| Privacy mentions Meta/Facebook data (messages, Page ID, IG account) | ☐ | Already in pilot copy §3–§5 |
| Privacy describes retention, subprocessors (Supabase, Meta, LLM provider) | ☐ | Update before paid pilot if subprocessors change |
| Terms describe B2B SaaS + pilot limitations | ☐ | |
| Same URLs entered in Meta App → **Settings → Basic** | ☐ | Privacy Policy URL + Terms of Service URL |
| Data deletion instructions URL (optional but recommended) | ☐ | Link to privacy § rights or support email |

**Staging:** use `https://staging-<app-host>/legal/privacy` and `/legal/terms` if staging web is deployed; do not point Meta prod app at localhost.

---

## 4. Webhook configuration

| Setting | Value |
|---------|--------|
| Callback URL | `https://<api-host>/v1/webhooks/meta` |
| Verify token | Same as env `META_VERIFY_TOKEN` (min 8 chars) |
| Subscription object | **Page** |
| Fields | **`messages`** (minimum for DM ingest) |

| Item | Done | Notes |
|------|:----:|-------|
| GET verify returns challenge (200) | ☐ | `MetaWebhookService.verifySubscription` |
| POST signed with `X-Hub-Signature-256` | ☐ | `META_APP_SECRET` must match app |
| API returns **200 quickly** (receipt + outbox enqueue, not full AI inline) | ☐ | |
| `webhook_receipts` row on test DM | ☐ | SQL in [meta-down runbook](./runbooks/meta-down.md) |
| Inngest / worker processing `meta.inbound` | ☐ | |
| Rate limit headroom (`RATE_LIMIT_WEBHOOK_*`, default 200/min) | ☐ | |

**Local dev:** tunnel to API `:3001` only — not web `:3000`. See README § Meta webhook.

**Production vs staging:** separate callback URLs or separate Meta apps; never share verify token across untrusted envs.

---

## 5. OAuth / Facebook Login

| Setting | Value |
|---------|--------|
| Valid OAuth Redirect URIs | `https://<app-host>/settings/channels/callback` |
| Env `META_REDIRECT_URI` | Must match exactly (scheme, host, path) |
| Deauthorize / Data deletion callback | Configure when Meta asks (Phase 1: document support process) |

| Item | Done | Notes |
|------|:----:|-------|
| Connect flow: Settings → Kết nối kênh → Meta OAuth → pick Page | ☐ | |
| `channel_connections` rows for `meta_page` + `meta_ig` when IG linked | ☐ | |
| Page access token stored encrypted (`TOKEN_ENCRYPTION_KEY`) | ☐ | |
| Reconnect works after token revoke (`needs_reauth`) | ☐ | |

---

## 6. Test users & assets

Prepare **before** screencast and App Review testing.

| Asset | Done | Notes |
|-------|:----:|-------|
| Facebook **test user** (or real admin account added as app tester) | ☐ | App Roles → Testers / Developers |
| Facebook **Page** (test shop Page) | ☐ | Test user must be Page admin |
| Instagram **Professional** account linked to that Page | ☐ | Required for IG DM permission demo |
| Second test user to send DMs **as customer** | ☐ | Messenger + IG apps on phone |
| Omni **staging org** with owner login for reviewer | ☐ | Provide credentials in review notes if Meta allows |
| Seed catalog product (optional) | ☐ | Helps demo order-from-inbox |

**Development mode:** only users with a role on the app can complete OAuth. Add reviewers as testers or submit for review.

---

## 7. Screencast script (≈3–5 min)

Record **1080p**, show UI + Meta side where helpful, no cuts that hide permission prompts.

1. **Intro (15 s)** — "Omni Commerce helps shop owners manage Facebook Page and Instagram DMs in one inbox."
2. **Login** — Owner signs in to web app (staging URL).
3. **Connect channel** — Settings → connect Meta → Facebook login → grant permissions → select test Page.
4. **Inbound Messenger** — Customer test user sends DM to Page; show conversation appearing in Inbox within ~1 min.
5. **Human reply** — Staff sends reply from Omni; show delivery in Messenger client.
6. **Instagram DM** (if IG linked) — Repeat inbound + reply on IG.
7. **Takeover / AI** (if enabled) — Show staff can take control; AI does not send after takeover.
8. **Data & privacy** — Briefly open `/legal/privacy` and mention owner can export/delete org data (PDPA).
9. **Outro** — Restate: only connected Page/IG, B2B shop use, no consumer social features.

**Reviewer notes field (paste):**

```
Test login: <email> / <password> (staging)
Test Page: <Page name> — send Messenger DM from tester account <name>
Webhook: https://<api-host>/v1/webhooks/meta (always-on)
Permissions used only for inbox sync + reply on user-selected Page/IG.
```

---

## 8. Staging pilot gate (pre-customer)

Run on **staging** Supabase + staging hosts before first paying pilot.

| Gate | Done | Notes |
|------|:----:|-------|
| Staging ≠ production Supabase project | ☐ | Charter requirement |
| E2E: DM → `webhook_receipts` → inbox message row | ☐ | |
| E2E: outbound reply delivered in Messenger/IG | ☐ | |
| OAuth connect + disconnect/reconnect | ☐ | |
| Legal pages live on staging web | ☐ | |
| PDPA export (`GET /v1/orgs/me/export`) | ☐ | [pdpa-delete runbook](./runbooks/pdpa-delete.md) |
| Rate limits smoke (no false 429 on normal webhook burst) | ☐ | |
| `pnpm test:isolation` green on CI | ☐ | |
| Runbook links in README | ☐ | |
| App Review submitted **or** pilot limited to app testers until approved | ☐ | Do not promise self-serve OAuth at scale pre-approval |

---

## 9. Submission day

1. Meta App → **App Review** → **Permissions and Features** → request Advanced Access for §2 list.
2. Attach screencast; paste use case + test credentials.
3. Confirm Privacy/Terms URLs in App Settings.
4. Submit; typical turnaround **3–10 business days** (plan buffer).
5. On rejection: read policy reason, fix gap, resubmit — do not add unused permissions.

---

## 10. Related docs

- [Meta down runbook](./runbooks/meta-down.md) — webhook / DLQ triage
- [PDPA delete runbook](./runbooks/pdpa-delete.md) — org delete/anonymize
- [External services catalog](./superpowers/specs/2026-07-24-external-services-catalog.md) §5 Meta
- [Plan D priority execution](./superpowers/plans/2026-07-24-plan-d-priority-execution.md) — gate D9
