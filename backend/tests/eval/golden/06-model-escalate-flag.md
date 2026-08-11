# 06 Model escalate flag honored

## Prompt

Váy midi có bảo hành không?

## Knowledge chunks

1. Váy midi chất liệu linen, giá 450.000đ; không ghi rõ chính sách bảo hành trong mô tả sản phẩm.

## Mock LLM response

```json
{"replyText":"Minh se chuyen doi ngu ho tro kiem tra chinh sach bao hanh.","citedIndices":[],"escalate":true}
```

## Expected

escalate: true
skip_llm: false

## Expected grounded behavior

Honor model escalate when warranty is not in chunks; hand off instead of inventing policy.
