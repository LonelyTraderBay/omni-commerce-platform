# 04 Return policy grounded

## Prompt

Mình muốn đổi size trong 3 ngày được không?

## Knowledge chunks

1. Chính sách đổi trả: đổi size trong 7 ngày nếu còn tem mác và chưa giặt.

## Mock LLM response

```json
{"replyText":"Shop hỗ trợ đổi size trong 7 ngày nếu còn tem mác và chưa giặt [1].","citedIndices":[1],"escalate":false}
```

## Expected

escalate: false
min_citations: 1
reply_contains: 7 ngày

## Expected grounded behavior

Explain return window from policy chunk; do not authorize refunds without staff review.
