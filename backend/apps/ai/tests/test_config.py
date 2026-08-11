from app.config import Settings


def test_settings_reads_service_m2m_key_from_the_environment(monkeypatch):
    """
    Regression guard for the bug where backend/apps/ai silently used the hardcoded
    default service_m2m_key instead of the real shared secret, because
    infra/scripts/dev-local.ps1 never copied the root .env to backend/apps/ai/.env
    (Settings reads `.env` relative to backend/apps/ai's own working directory, per
    the `class Config: env_file = ".env"` below).

    This only guards app/config.py's OWN loading behavior — that Settings()
    actually picks up SERVICE_M2M_KEY from the environment rather than
    quietly keeping the default — it can't catch the "forgot to copy the
    file" failure mode by itself. See infra/scripts/local-e2e-smoke.mjs's
    waitForKnowledgeChunks() (end-to-end) and infra/scripts/dev-local.ps1's
    SERVICE_M2M_KEY parity check (fast-fail at stack startup) for that.
    """
    monkeypatch.setenv("SERVICE_M2M_KEY", "env-provided-shared-secret-value")

    assert Settings().service_m2m_key == "env-provided-shared-secret-value"


def test_default_core_base_url_matches_the_locked_local_api_port(monkeypatch):
    """
    Regression guard for the stale default (core_base_url was previously
    "http://127.0.0.1:3001", which does not match infra/config/local-ports.json's
    locked api port 4701) silently pointing server-to-server tool calls at
    the wrong port whenever CORE_BASE_URL isn't set in the environment.

    `_env_file=None` isolates this from whatever backend/apps/ai/.env happens to
    contain on this machine, so the assertion is about the *code's* default,
    not this dev environment's local file.
    """
    monkeypatch.delenv("CORE_BASE_URL", raising=False)

    assert Settings(_env_file=None).core_base_url == "http://127.0.0.1:4701"
