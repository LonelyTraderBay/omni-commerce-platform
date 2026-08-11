# Subprocessors change — customer notification

**Status:** Eng process template ready (SDD E5 Task 4). **Legal/owner approval of wording and send still AMBER** — do not claim customers were notified or I5 full GREEN.  
**Source of truth:** [docs/legal/subprocessors.md](../legal/subprocessors.md) → public `/legal/subprocessors`.

Use when a **material** subprocessor is added, removed, or materially changes purpose/region/data scope.

## Approval gate (required before send)

1. Eng drafts list diff + notice text (email and/or in-app).
2. **Legal or owner** reviews and approves wording + channel + audience.
3. Only after written approve (ticket comment / email): publish list + send notice.
4. Record approver name, date, and ticket id in the ops ticket. **Do not invent approval.**

## Checklist

- [ ] Diff recorded: old → new vendor / purpose / data / region
- [ ] Update `docs/legal/subprocessors.md` and `frontend/apps/web/.../legal/subprocessors/page.tsx` (same list)
- [ ] Deploy public page; confirm `/legal/subprocessors` shows new list
- [ ] Fill email and/or in-app template below; legal/owner **approve**
- [ ] Send to affected pilot/enterprise contacts (or in-app banner to those orgs)
- [ ] File sent copy + timestamp + recipient count in ops ticket
- [ ] Link ticket from DPA / customer folder if required by contract

## Email template (draft — needs legal/owner approve)

**Subject:** Omni Commerce — cập nhật danh sách subprocessors

```
Xin chào [Tên / Org],

Chúng tôi cập nhật danh sách nhà xử lý phụ (subprocessors) dùng để vận hành Omni Commerce.

Thay đổi:
- [Thêm / Bỏ / Đổi]: [Tên vendor]
- Mục đích: […]
- Dữ liệu liên quan: […]
- Vùng (điển hình): […]
- Ngày hiệu lực: [YYYY-MM-DD]

Danh sách đầy đủ: https://[host]/legal/subprocessors

Nếu có câu hỏi về xử lý dữ liệu hoặc DPA, vui lòng trả lời email này.

Trân trọng,
[Tên] — Omni Commerce
```

## In-app notice template (draft — needs legal/owner approve)

```
Cập nhật subprocessors — [YYYY-MM-DD]
[Thêm/Bỏ/Đổi] [Vendor]: [một câu mục đích]. Chi tiết: /legal/subprocessors
```

Banner / settings notice for org owners; dismissible after acknowledge if product supports it.

## Exit notes

| Claim | When |
|-------|------|
| Eng process GREEN/AMBER | This runbook + templates exist |
| Legal/owner AMBER | Until first approved send (or explicit waive) on a real change |
| I5 full GREEN | Public list **and** approved notification process in use — **not claimed here** |
| E100 | Not claimed |
