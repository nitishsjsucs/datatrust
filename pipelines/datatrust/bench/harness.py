"""Fault-injection benchmark harness, offline mode (SPEC 12.2).

One trial: generate (seed), inject (source scenarios), overlay the dbt project (scenario patch + decoys),
load into a fresh DuckDB file, `dbt-ol build`, classify checks, then (if anything failed) trace and plan in
TypeScript, run probes in Python on a read-only connection, sanitize in TypeScript and rank in TypeScript.
The ranker sees checks, lineage, relations, sanitized probe results and baseline checksums only; the
scenario id and ground truth stay in the harness (ADR-0004).
"""

from __future__ import annotations

import json
import os
import shutil
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from datatrust import config
from datatrust.bench.scenarios import BY_ID, SCENARIOS, Scenario, inject, patches_for
from datatrust.checks.results import classify
from datatrust.dbt.build import build_with_lineage, relations_map, run_dbt
from datatrust.dbt.overlay import make_overlay
from datatrust.diagnostics.probes import ProbeRequest, run_probes
from datatrust.load.duckdb_loader import load_raw
from datatrust.rca_cli import rca
from datatrust.synth.generator import generate, write_dataset
from datatrust.warehouse.duckdb_wh import DuckDBWarehouse

BENCH_KEY = "datatrust-bench-evidence-key-not-a-secret"


@dataclass(frozen=True)
class TrialSpec:
    seed: int
    scenario_id: str | None  # None = clean trial

    @property
    def trial_id(self) -> str:
        return f"s{self.seed}-{self.scenario_id or 'clean'}"


def baseline_checksums(work_dir: Path) -> dict[str, str | None]:
    """Model checksums of the unpatched project (the 'last green run' manifest)."""
    target = work_dir / "baseline-parse"
    res = run_dbt(["parse"], target_path=target, duckdb_path=work_dir / "baseline-parse.duckdb")
    if res.returncode != 0:
        raise RuntimeError(res.stdout[-3000:])
    rel = relations_map(res.manifest())
    return {k: v["checksum"] for k, v in rel["nodes"].items() if v["kind"] == "model"}


def run_trial(
    spec: TrialSpec, work_dir: Path, baseline: dict[str, str | None], keep: bool = False
) -> dict[str, Any]:
    t0 = time.perf_counter()
    scenario: Scenario | None = BY_ID[spec.scenario_id] if spec.scenario_id else None
    trial_dir = work_dir / spec.trial_id
    if trial_dir.exists():
        shutil.rmtree(trial_dir)
    trial_dir.mkdir(parents=True)
    timings: dict[str, float] = {}

    ds = generate(spec.seed)
    injection = inject(ds, spec.seed, scenario) if scenario else {}
    write_dataset(ds, trial_dir / "raw")
    patches, decoy_ids = patches_for(spec.seed, scenario)
    project = make_overlay(trial_dir / "dbt", patches)
    db = trial_dir / "warehouse.duckdb"
    load_raw(trial_dir / "raw", db)
    timings["prepare"] = time.perf_counter() - t0

    t1 = time.perf_counter()
    snapshots = trial_dir / "snapshots"
    res = build_with_lineage(
        project_dir=project,
        target_path=trial_dir / "target",
        duckdb_path=db,
        env_extra={"DATATRUST_SNAPSHOT_DIR": str(snapshots)},
    )
    timings["dbt"] = time.perf_counter() - t1
    if not (trial_dir / "target" / "run_results.json").exists():
        raise RuntimeError(f"{spec.trial_id}: dbt produced no run_results\n{res.stdout[-3000:]}")
    checks = [c.to_json() for c in classify(res.run_results(), res.manifest())]
    failing = sorted(c["checkId"] for c in checks if c["status"] in ("fail", "error"))
    record: dict[str, Any] = {
        "trial": spec.trial_id,
        "seed": spec.seed,
        "scenario": spec.scenario_id,
        "kind": scenario.kind if scenario else "clean",
        "groundTruth": scenario.ground_truth if scenario else None,
        "groundTruthColumn": scenario.ground_truth_column if scenario else None,
        "injection": injection,
        "decoys": decoy_ids,
        "failing": failing,
        "detected": bool(failing),
        "checkCounts": {
            s: sum(1 for c in checks if c["status"] == s) for s in ("pass", "fail", "error", "skip")
        },
    }
    if failing:
        t2 = time.perf_counter()
        rel = json.loads((trial_dir / "target" / "relations.json").read_text())
        graph = rca("graph", {"events": res.openlineage_events(), "relations": rel})
        plan = rca("plan", {"checks": checks, "graph": graph, "relations": rel})
        timings["plan"] = time.perf_counter() - t2
        t3 = time.perf_counter()
        with DuckDBWarehouse(db, snapshot_dir=snapshots) as wh:
            raw_results = [
                r.to_json() for r in run_probes([ProbeRequest.from_json(p) for p in plan["probes"]], wh, rel)
            ]
        timings["probes"] = time.perf_counter() - t3
        t4 = time.perf_counter()
        sanitized = rca(
            "sanitize",
            {"probeResults": raw_results, "relations": rel},
            env_extra={"EVIDENCE_HMAC_KEY": BENCH_KEY},
        )["probeResults"]
        ranked = rca(
            "rank",
            {
                "checks": checks,
                "graph": graph,
                "relations": rel,
                "probeResults": sanitized,
                "baselineChecksums": baseline,
            },
        )
        coverage = rca("coverage", {"graph": graph})
        evidence = rca(
            "evidence",
            {
                "incidentId": f"inc_{spec.trial_id}",
                "runId": spec.trial_id,
                "trigger": "checks",
                "checks": checks,
                "ranked": ranked["ranked"],
                "probeResults": sanitized,
                "relations": rel,
            },
        )
        prompt = rca("prompt", {"evidence": evidence})
        template = rca("template", {"evidence": evidence})
        timings["rank"] = time.perf_counter() - t4
        record.update(
            {
                "candidateCount": len(ranked["features"]["column"]),
                "ranked": [c["node"] for c in ranked["ranked"]],
                "rankedColumns": {c["node"]: c["columns"] for c in ranked["ranked"][:3]},
                "top": ranked["ranked"][:5],
                "features": ranked["features"],
                "ablations": ranked["ablations"],
                "baselines": ranked["baselines"],
                "probeCount": len(plan["probes"]),
                "probeStatus": {
                    s: sum(1 for r in sanitized if r["status"] == s) for s in ("ok", "error", "missing")
                },
                "lineageCoverage": coverage,
                # Kept in memory for the PII prompt test; dropped from saved reports (report.slim).
                "promptText": "\n".join(m["content"] for m in prompt["messages"]),
                "evidence": evidence,
                "summaryText": json.dumps(template["rendered"]),
            }
        )
    record["timings"] = {k: round(v, 3) for k, v in timings.items()}
    record["wallSeconds"] = round(time.perf_counter() - t0, 3)
    if not keep:
        shutil.rmtree(trial_dir, ignore_errors=True)
    return record


def _run(args: tuple[TrialSpec, str, dict[str, str | None], bool]) -> dict[str, Any]:
    spec, work, baseline, keep = args
    return run_trial(spec, Path(work), baseline, keep)


def trial_specs(
    seeds: list[int], scenario_ids: list[str] | None = None, clean: bool = True
) -> list[TrialSpec]:
    ids = scenario_ids or [s.id for s in SCENARIOS]
    specs = [TrialSpec(seed, sid) for seed in seeds for sid in ids]
    if clean:
        specs += [TrialSpec(seed, None) for seed in seeds]
    return specs


def run_bench(
    specs: list[TrialSpec],
    *,
    work_dir: Path | None = None,
    workers: int | None = None,
    keep: bool = False,
    progress: bool = True,
) -> list[dict[str, Any]]:
    work = (work_dir or config.DATA_DIR / "bench").resolve()
    work.mkdir(parents=True, exist_ok=True)
    baseline = baseline_checksums(work)
    n = workers or max(1, min(4, (os.cpu_count() or 2) // 2))
    out: list[dict[str, Any]] = []
    args = [(s, str(work), baseline, keep) for s in specs]
    if n == 1:
        for a in args:
            out.append(_run(a))
            if progress:
                _print_progress(out[-1], len(out), len(args))
    else:
        with ProcessPoolExecutor(max_workers=n) as pool:
            for rec in pool.map(_run, args):
                out.append(rec)
                if progress:
                    _print_progress(rec, len(out), len(args))
    return out


def _print_progress(rec: dict[str, Any], i: int, n: int) -> None:
    gt = rec.get("groundTruth")
    ranked = rec.get("ranked") or []
    pos = ranked.index(gt) + 1 if gt in ranked else None
    print(
        f"[{i}/{n}] {rec['trial']}: failing={','.join(rec['failing']) or '-'} gt_rank={pos} "
        f"({rec['wallSeconds']}s)",
        flush=True,
    )
