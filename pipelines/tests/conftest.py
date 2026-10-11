from __future__ import annotations

import functools

import pytest

from datatrust.synth.generator import Dataset, generate


@functools.lru_cache(maxsize=8)
def _cached(seed: int) -> Dataset:
    return generate(seed)


@pytest.fixture(scope="session")
def dataset_factory():
    """Generated datasets are deterministic, so they are shared across tests (read-only)."""
    return _cached
