# 03 Shipping fee grounded

## Prompt

Shop giao hàng nội thành HCM phí ship bao nhiêu?

## Knowledge chunks

1. Chính sách giao hàng: nội thành TP.HCM 25.000đ, ngoại thành 35.000đ, COD được hỗ trợ.

## Mock LLM response

```json
{"replyText":"Phí ship nội thành TP.HCM là 25.000đ [1].","citedIndices":[1],"escalate":false}
```

## Expected

escalate: false
min_citations: 1
reply_contains: 25.000

## Expected grounded behavior

Quote the shipping fee from policy chunk [1]; do not invent free-ship thresholds.
