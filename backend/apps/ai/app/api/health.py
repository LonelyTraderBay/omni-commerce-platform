from fastapi import APIRouter, Header, HTTPException

from app.config import settings

router = APIRouter()


@router.get("/health")
def health(
    traceparent: str | None = Header(default=None),
    x_service_key: str | None = Header(default=None),
):
    if x_service_key is not None and x_service_key != settings.service_m2m_key:
        raise HTTPException(status_code=401, detail="invalid service key")

    body = {"status": "ok"}
    if traceparent:
        body["traceparent"] = traceparent
    return body
