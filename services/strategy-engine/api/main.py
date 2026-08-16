from __future__ import annotations

import json
from collections.abc import AsyncIterator

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from api.auth import require_auth
from config.settings import KILL_SWITCH_PATH, LOG_DIR, settings
from core.models import Event, EventType, KillSwitchRequest, ScanRequest
from engine.safety import is_kill_switch_active
from events.bus import EventBus
from strategies.registry import registry


app = FastAPI(title="Tradora Strategy Engine", version="0.1.0")
bus = EventBus(LOG_DIR / "events.db")
auth_dependencies = [Depends(require_auth)]


def health_payload() -> dict[str, str]:
    return {"status": "ok", "mode": "paper_only"}


@app.get("/health", dependencies=auth_dependencies)
@app.get("/api/v1/health", dependencies=auth_dependencies)
def health() -> dict[str, str]:
    return health_payload()


@app.get("/strategies", dependencies=auth_dependencies)
@app.get("/api/v1/strategies", dependencies=auth_dependencies)
def strategies() -> dict[str, object]:
    return {"strategies": registry.list()}


@app.get("/api/v1/config", dependencies=auth_dependencies)
def config() -> dict[str, object]:
    return {
        "host": settings.host,
        "port": settings.port,
        "alpaca_base_url": settings.alpaca_base_url,
        "remote_clear_allowed": settings.remote_clear_allowed,
        "max_daily_loss_pct": settings.max_daily_loss_pct,
        "max_position_pct_of_equity": settings.max_position_pct_of_equity,
        "api_access_token_configured": bool(settings.api_access_token),
        "allowed_modes": ["analysis", "dry_run", "paper"],
    }


@app.get("/api/v1/kill-switch", dependencies=auth_dependencies)
def kill_switch_status() -> dict[str, bool]:
    return {"active": is_kill_switch_active()}


@app.post("/api/v1/kill-switch", dependencies=auth_dependencies)
def set_kill_switch(request: KillSwitchRequest) -> dict[str, object]:
    if not request.enabled and not settings.remote_clear_allowed:
        raise HTTPException(status_code=403, detail="Remote clearing is disabled")
    if request.enabled:
        KILL_SWITCH_PATH.touch()
        event_type = EventType.KILL_SWITCH_TRIPPED
    else:
        KILL_SWITCH_PATH.unlink(missing_ok=True)
        event_type = EventType.SIGNAL_GENERATED
    bus.publish(
        Event(
            type=event_type,
            severity="critical" if request.enabled else "warning",
            payload={"enabled": request.enabled, "source": request.source},
        )
    )
    return {"active": request.enabled, "source": request.source}


@app.post("/api/v1/scan/run", dependencies=auth_dependencies)
def run_scan(request: ScanRequest) -> dict[str, object]:
    if request.mode not in {"analysis", "dry_run", "paper"}:
        raise HTTPException(
            status_code=400,
            detail="mode must be analysis, dry_run, or paper",
        )
    event = Event(
        type=EventType.SIGNAL_GENERATED,
        severity="info",
        payload={"mode": request.mode, "asset_class": request.asset_class.value},
    )
    bus.publish(event)
    return {"status": "accepted", "mode": request.mode, "event_id": event.event_id}


@app.get("/api/v1/events/stream", dependencies=auth_dependencies)
async def event_stream() -> StreamingResponse:
    queue = bus.subscribe()

    async def generate() -> AsyncIterator[str]:
        try:
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event.model_dump(mode='json'))}\n\n"
        finally:
            bus.unsubscribe(queue)

    return StreamingResponse(generate(), media_type="text/event-stream")
