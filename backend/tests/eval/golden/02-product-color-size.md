# 02 Product color and size grounded

## Prompt

Áo khoác denim có màu xanh size M không?

## Knowledge chunks

1. Áo khoác denim màu xanh indigo, size S/M/L, tồn kho 12 chiếc.

## Mock LLM response

```json
{"replyText":"Áo khoác denim có màu xanh indigo và còn size M [1].","citedIndices":[1],"escalate":false}
```

## Expected

escalate: false
min_citations: 1
reply_contains: size M

## Expected grounded behavior

Confirm color and size only from the chunk; do not promise delivery dates.
