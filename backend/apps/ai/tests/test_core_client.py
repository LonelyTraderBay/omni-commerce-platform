import json

from app.infra.core import CoreKnowledgeClient

ORG_ID = "11111111-1111-1111-1111-111111111111"
PRODUCT_ID = "22222222-2222-2222-2222-222222222222"
VARIANT_ID = "33333333-3333-3333-3333-333333333333"


class FakeResponse:
    def __init__(self, body: dict):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self.body).encode("utf-8")


def test_core_tool_methods_post_with_service_key():
    calls = []

    def fake_opener(req, timeout):
        calls.append(
            {
                "url": req.full_url,
                "timeout": timeout,
                "service_key": req.headers.get("X-service-key")
                or req.headers.get("X-service-Key")
                or req.headers.get("X-Service-key")
                or req.headers.get("X-Service-Key"),
                "body": json.loads(req.data.decode("utf-8")),
            }
        )
        if req.full_url.endswith("/internal/v1/tools/get-product"):
            return FakeResponse({"product": {"id": PRODUCT_ID}})
        return FakeResponse({"order": {"id": "order-1"}, "items": []})

    client = CoreKnowledgeClient(
        base_url="https://core.example.test",
        service_key="service-key",
        opener=fake_opener,
    )

    assert client.get_product(org_id=ORG_ID, product_id=PRODUCT_ID) == {
        "product": {"id": PRODUCT_ID}
    }
    assert client.create_draft_order(
        org_id=ORG_ID,
        conversation_id=None,
        contact_id=None,
        idempotency_key=None,
        items=[{"variantId": VARIANT_ID, "qty": 1}],
    ) == {"order": {"id": "order-1"}, "items": []}

    assert calls[0] == {
        "url": "https://core.example.test/internal/v1/tools/get-product",
        "timeout": 15,
        "service_key": "service-key",
        "body": {"orgId": ORG_ID, "productId": PRODUCT_ID},
    }
    assert calls[1] == {
        "url": "https://core.example.test/internal/v1/tools/create-draft-order",
        "timeout": 30,
        "service_key": "service-key",
        "body": {
            "orgId": ORG_ID,
            "conversationId": None,
            "contactId": None,
            "idempotencyKey": None,
            "items": [{"variantId": VARIANT_ID, "qty": 1}],
        },
    }
