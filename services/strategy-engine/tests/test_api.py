from __future__ import annotations

from fastapi.testclient import TestClient

import api.auth as auth
import api.main as api_main
from api.main import app
from config.settings import Settings


def client() -> TestClient:
    return TestClient(app)


def authenticate(monkeypatch) -> dict[str, str]:
    test_settings = Settings(api_access_token="test-token")
    monkeypatch.setattr(auth, "settings", test_settings)
    monkeypatch.setattr(api_main, "settings", test_settings)
    return {"Authorization": "Bearer test-token"}


def test_auth_required() -> None:
    response = client().get("/health")
    assert response.status_code == 401


def test_health_authenticated(monkeypatch) -> None:
    response = client().get("/health", headers=authenticate(monkeypatch))
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "mode": "paper_only"}


def test_legacy_health_path_remains_available(monkeypatch) -> None:
    response = client().get("/api/v1/health", headers=authenticate(monkeypatch))
    assert response.status_code == 200


def test_strategies_is_read_only_and_empty_initially(monkeypatch) -> None:
    response = client().get("/strategies", headers=authenticate(monkeypatch))
    assert response.status_code == 200
    assert response.json() == {"strategies": []}


def test_scan_rejects_live_mode(monkeypatch) -> None:
    response = client().post(
        "/api/v1/scan/run",
        json={"mode": "live", "asset_class": "stocks"},
        headers=authenticate(monkeypatch),
    )
    assert response.status_code == 400


def test_scan_accepts_v1_modes(monkeypatch) -> None:
    headers = authenticate(monkeypatch)
    for mode in ("analysis", "dry_run", "paper"):
        response = client().post(
            "/api/v1/scan/run",
            json={"mode": mode, "asset_class": "crypto"},
            headers=headers,
        )
        assert response.status_code == 200
        assert response.json()["mode"] == mode


def test_kill_switch_blocks_remote_clear(monkeypatch) -> None:
    response = client().post(
        "/api/v1/kill-switch",
        json={"enabled": False, "source": "test"},
        headers=authenticate(monkeypatch),
    )
    assert response.status_code == 403
