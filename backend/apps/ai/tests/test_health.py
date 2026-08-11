from fastapi.testclient import TestClient
from app.config import settings
from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_health_echoes_traceparent():
    traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
    r = client.get("/health", headers={"traceparent": traceparent})
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "traceparent": traceparent}


def test_health_rejects_wrong_service_key():
    r = client.get("/health", headers={"x-service-key": "wrong-key"})
    assert r.status_code == 401


def test_health_accepts_correct_service_key_and_echoes_traceparent():
    traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
    r = client.get(
        "/health",
        headers={
            "traceparent": traceparent,
            "x-service-key": settings.service_m2m_key,
        },
    )
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "traceparent": traceparent}
