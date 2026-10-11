"""Temporary copy of the dbt project with unified-diff patches applied (SPEC 12.1).

The applier is strict: every hunk's context and removed lines must match the file exactly (at the stated
line or at the nearest offset), and hunks may not overlap, so a decoy that collides with a scenario patch
fails loudly instead of silently changing the scenario. `test_patch_combinations.py` applies every
(scenario, decoy set) the benchmark draws.
"""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from datatrust import config

_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class PatchError(ValueError):
    pass


@dataclass
class Hunk:
    old_start: int
    lines: list[str]  # each starts with ' ', '-' or '+'

    def old(self) -> list[str]:
        return [ln[1:] for ln in self.lines if ln[:1] in (" ", "-")]

    def new(self) -> list[str]:
        return [ln[1:] for ln in self.lines if ln[:1] in (" ", "+")]


@dataclass
class FilePatch:
    path: str
    hunks: list[Hunk]


def parse_patch(text: str) -> list[FilePatch]:
    files: list[FilePatch] = []
    current: FilePatch | None = None
    hunk: Hunk | None = None
    for raw in text.splitlines():
        if raw.startswith("--- "):
            hunk = None
            continue
        if raw.startswith("+++ "):
            path = raw[4:].split("\t")[0].strip()
            path = path[2:] if path.startswith(("a/", "b/")) else path
            current = FilePatch(path, [])
            files.append(current)
            continue
        m = _HUNK.match(raw)
        if m:
            if current is None:
                raise PatchError("hunk before file header")
            hunk = Hunk(int(m.group(1)), [])
            current.hunks.append(hunk)
            continue
        if hunk is not None and raw[:1] in (" ", "-", "+"):
            hunk.lines.append(raw)
        elif hunk is not None and raw == "":
            hunk.lines.append(" ")
        elif raw.startswith("\\"):
            continue
    if not files:
        raise PatchError("no file in patch")
    return files


def apply_to_text(text: str, fp: FilePatch) -> str:
    lines = text.split("\n")
    out: list[str] = []
    cursor = 0
    for h in fp.hunks:
        old = h.old()
        want = h.old_start - 1
        pos = None
        for delta in range(0, len(lines) + 1):
            for cand in (want - delta, want + delta):
                if cursor <= cand <= len(lines) - len(old) and lines[cand : cand + len(old)] == old:
                    pos = cand
                    break
            if pos is not None:
                break
        if pos is None:
            raise PatchError(f"{fp.path}: hunk at line {h.old_start} does not apply")
        out.extend(lines[cursor:pos])
        out.extend(h.new())
        cursor = pos + len(old)
    out.extend(lines[cursor:])
    return "\n".join(out)


def apply_patches(files: dict[str, str], patches: list[str]) -> dict[str, str]:
    """Apply patch texts in order to an in-memory {relative path: content} map."""
    out = dict(files)
    for text in patches:
        for fp in parse_patch(text):
            if fp.path not in out:
                raise PatchError(f"{fp.path}: no such file")
            out[fp.path] = apply_to_text(out[fp.path], fp)
    return out


def project_files(project_dir: Path = config.DBT_DIR) -> dict[str, str]:
    files = {}
    for path in sorted(project_dir.rglob("*")):
        rel = path.relative_to(project_dir).as_posix()
        if path.is_file() and not rel.startswith(("target/", "logs/", "dbt_packages/")):
            files[rel] = path.read_text()
    return files


def make_overlay(dest: Path, patches: list[str], project_dir: Path = config.DBT_DIR) -> Path:
    """Copy the dbt project to `dest` and apply the patches; returns `dest`."""
    files = apply_patches(project_files(project_dir), patches)
    if dest.exists():
        shutil.rmtree(dest)
    for rel, content in files.items():
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    return dest
