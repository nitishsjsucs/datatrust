"""Deterministic random helpers built only on ``random.Random.random()``.

Python documents the output of ``random()`` as reproducible across versions for a
given seed; the other methods (``randint``, ``shuffle``, ``choice``) are not
guaranteed. Every draw here is converted to an integer with plain arithmetic, and no
floating point function from libm (``exp``, ``log``, ``pow``) is used, so the same
seed gives byte-identical output on macOS and Linux (SPEC section 6.1).
"""

from __future__ import annotations

import random
from collections.abc import MutableSequence, Sequence


def make(seed: int) -> random.Random:
    return random.Random(seed)


def randint(r: random.Random, lo: int, hi: int) -> int:
    """Uniform integer in the closed range [lo, hi]."""
    if hi < lo:
        raise ValueError(f"empty range [{lo}, {hi}]")
    return lo + int(r.random() * (hi - lo + 1))


def choice[T](r: random.Random, seq: Sequence[T]) -> T:
    return seq[randint(r, 0, len(seq) - 1)]


def shuffle[T](r: random.Random, items: MutableSequence[T]) -> None:
    """In-place Fisher-Yates shuffle."""
    for i in range(len(items) - 1, 0, -1):
        j = randint(r, 0, i)
        items[i], items[j] = items[j], items[i]


def sample[T](r: random.Random, seq: Sequence[T], k: int) -> list[T]:
    """k distinct items, in draw order."""
    pool = list(seq)
    if k > len(pool):
        raise ValueError("sample larger than population")
    out: list[T] = []
    for _ in range(k):
        j = randint(r, 0, len(pool) - 1)
        out.append(pool.pop(j))
    return out


def chance(r: random.Random, numerator: int, denominator: int) -> bool:
    """True with probability numerator/denominator."""
    return randint(r, 1, denominator) <= numerator
