import json
from urllib import error, request

from app.config import settings


class CoreKnowledgeClient:
    def __init__(
        self,
        base_url: str | None = None,
        service_key: str | None = None,
        opener=request.urlopen,
    ):
        self.base_url = (base_url or settings.core_base_url).rstrip("/")
        self.service_key = service_key or settings.service_m2m_key
        self.opener = opener

    def replace_chunks(
        self,
        *,
        org_id: str,
        source_type: str,
        source_id: str,
        chunks: list[dict],
    ) -> dict:
        req = request.Request(
            f"{self.base_url}/internal/v1/knowledge/chunks",
            data=json.dumps(
                {
                    "orgId": org_id,
                    "sourceType": source_type,
                    "sourceId": source_id,
                    "chunks": chunks,
                }
            ).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Service-Key": self.service_key,
            },
            method="POST",
        )

        try:
            with self.opener(req, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Core knowledge ingest failed: {exc.code} {detail}") from exc

    def retrieve_chunks(
        self,
        *,
        org_id: str,
        embedding: list[float],
        top_k: int,
    ) -> list[dict]:
        req = request.Request(
            f"{self.base_url}/internal/v1/knowledge/retrieve",
            data=json.dumps(
                {
                    "orgId": org_id,
                    "embedding": embedding,
                    "topK": top_k,
                }
            ).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Service-Key": self.service_key,
            },
            method="POST",
        )

        try:
            with self.opener(req, timeout=30) as response:
                body = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Core knowledge retrieve failed: {exc.code} {detail}") from exc

        chunks = body.get("chunks")
        if not isinstance(chunks, list):
            raise RuntimeError("Core knowledge retrieve returned invalid chunks")

        return chunks

    def get_product(
        self,
        *,
        org_id: str,
        product_id: str,
    ) -> dict:
        req = request.Request(
            f"{self.base_url}/internal/v1/tools/get-product",
            data=json.dumps(
                {
                    "orgId": org_id,
                    "productId": product_id,
                }
            ).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Service-Key": self.service_key,
            },
            method="POST",
        )

        try:
            with self.opener(req, timeout=15) as response:
                body = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Core get-product tool failed: {exc.code} {detail}"
            ) from exc

        if not isinstance(body.get("product"), dict):
            raise RuntimeError("Core get-product tool returned invalid product")
        return body

    def create_draft_order(
        self,
        *,
        org_id: str,
        conversation_id: str | None,
        contact_id: str | None,
        idempotency_key: str | None,
        items: list[dict],
    ) -> dict:
        payload: dict[str, object] = {
            "orgId": org_id,
            "conversationId": conversation_id,
            "contactId": contact_id,
            "idempotencyKey": idempotency_key,
            "items": items,
        }
        req = request.Request(
            f"{self.base_url}/internal/v1/tools/create-draft-order",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Service-Key": self.service_key,
            },
            method="POST",
        )

        try:
            with self.opener(req, timeout=30) as response:
                body = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Core create-draft-order tool failed: {exc.code} {detail}"
            ) from exc

        if not isinstance(body.get("order"), dict):
            raise RuntimeError("Core create-draft-order tool returned invalid order")
        return body

    def check_ai_token_quota(self, *, org_id: str) -> dict:
        req = request.Request(
            f"{self.base_url}/internal/v1/billing/ai-token-quota/check",
            data=json.dumps({"orgId": org_id}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Service-Key": self.service_key,
            },
            method="POST",
        )

        try:
            with self.opener(req, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            if exc.code == 429:
                detail = exc.read().decode("utf-8", errors="replace")
                try:
                    body = json.loads(detail)
                except json.JSONDecodeError:
                    body = {"message": detail}
                body["exceeded"] = True
                return body
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Core AI token quota check failed: {exc.code} {detail}"
            ) from exc

    def record_ai_token_usage(
        self,
        *,
        org_id: str,
        quantity: int,
        ref_type: str | None = None,
        ref_id: str | None = None,
    ) -> None:
        payload: dict[str, object] = {
            "orgId": org_id,
            "quantity": quantity,
        }
        if ref_type is not None:
            payload["refType"] = ref_type
        if ref_id is not None:
            payload["refId"] = ref_id

        req = request.Request(
            f"{self.base_url}/internal/v1/billing/ai-token-quota/record",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Service-Key": self.service_key,
            },
            method="POST",
        )

        try:
            with self.opener(req, timeout=15):
                return None
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Core AI token usage record failed: {exc.code} {detail}"
            ) from exc
