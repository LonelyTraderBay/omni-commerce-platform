# 01 Product price grounded

## Prompt

Áo thun basic giá bao nhiêu?

## Knowledge chunks

1. Áo thun basic cotton 100%, giá 199.000đ, còn hàng size S/M/L.

## Mock LLM response

```json
{"replyText":"Áo thun basic giá 199.000đ [1].","citedIndices":[1],"escalate":false}
```

## Expected

escalate: false
min_citations: 1
reply_contains: 199.000

## Expected grounded behavior

Answer with the listed price and cite chunk [1]; do not invent colors or discounts.
