import os

from app.config import settings


def init_instrumentation() -> None:
    if not settings.sentry_dsn:
        return

    import sentry_sdk

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=os.getenv("NODE_ENV", "development"),
    )
