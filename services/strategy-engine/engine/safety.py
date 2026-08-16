from __future__ import annotations

from config.settings import KILL_SWITCH_PATH, settings


def is_paper_endpoint() -> bool:
    return "paper-api" in settings.alpaca_base_url.lower()


def assert_paper_mode() -> None:
    if not is_paper_endpoint():
        raise RuntimeError(
            "Refusing to run: ALPACA_BASE_URL is not the paper trading endpoint."
        )


def is_kill_switch_active() -> bool:
    return KILL_SWITCH_PATH.exists()


def assert_order_submission_allowed() -> None:
    assert_paper_mode()
    if is_kill_switch_active():
        raise RuntimeError("Order submission refused: kill switch is active.")
