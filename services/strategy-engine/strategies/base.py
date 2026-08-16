from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence

from core.models import Bar, Signal


class Strategy(ABC):
    """Pure strategy contract. Strategies produce signals and never place orders."""

    name: str
    version: str = "1.0.0"

    @abstractmethod
    def evaluate(self, bars: Sequence[Bar]) -> list[Signal]:
        raise NotImplementedError
