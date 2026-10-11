"""`datatrust` command line entry point."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from datatrust import __version__

DUCKDB_HELP = "DuckDB file (default $DATATRUST_DUCKDB_PATH or .data/warehouse.duckdb)"


def _cmd_synth(args: argparse.Namespace) -> int:
    from datatrust import config
    from datatrust.synth.generator import generate, write_dataset

    out = Path(args.out) if args.out else config.raw_dir(args.seed)
    ds = generate(args.seed)
    m = write_dataset(ds, out)
    print(json.dumps({"out": str(out), "total_rows": m["total_rows"], "seed": args.seed}))
    return 0


def _cmd_load(args: argparse.Namespace) -> int:
    from datatrust import config
    from datatrust.synth.generator import generate, write_dataset

    if args.target != "duckdb":
        print("only --target duckdb is implemented so far", file=sys.stderr)
        return 2
    from datatrust.load.duckdb_loader import load_raw

    raw = Path(args.raw_dir) if args.raw_dir else config.raw_dir(args.seed)
    if not (raw / "manifest.json").exists():
        write_dataset(generate(args.seed), raw)
    db = Path(args.duckdb_path).resolve() if args.duckdb_path else config.duckdb_path()
    counts = load_raw(raw, db)
    print(json.dumps({"duckdb_path": str(db), "rows": counts, "total_rows": sum(counts.values())}))
    return 0


def _cmd_build(args: argparse.Namespace) -> int:
    from datatrust import config
    from datatrust.checks.results import classify, summarize
    from datatrust.dbt.build import build_with_lineage

    db = Path(args.duckdb_path).resolve() if args.duckdb_path else config.duckdb_path()
    target = Path(args.target_path).resolve() if args.target_path else config.DBT_DIR / "target"
    res = build_with_lineage(target_path=target, duckdb_path=db)
    if args.verbose:
        print(res.stdout)
    if not (target / "run_results.json").exists():
        print(res.stdout, file=sys.stderr)
        return res.returncode or 1
    results = classify(res.run_results(), res.manifest())
    print(
        json.dumps(
            {
                "target_path": str(target),
                "checks": summarize(results),
                "failing": [r.checkId for r in results if r.status in ("fail", "error")],
                "openlineage_events": len(res.openlineage_events()),
            }
        )
    )
    return res.returncode


def _parse_seeds(text: str) -> list[int]:
    seeds: list[int] = []
    for part in text.split(","):
        if "-" in part:
            lo, hi = part.split("-", 1)
            seeds.extend(range(int(lo), int(hi) + 1))
        elif part:
            seeds.append(int(part))
    return seeds


def _tune_trials(records: list[dict]) -> list[dict]:
    return [
        {
            "id": r["trial"],
            "scenario": r["scenario"],
            "groundTruth": r["groundTruth"],
            "rows": (r.get("features") or {}).get("column") or [],
        }
        for r in records
        if r.get("scenario")
    ]


def _cmd_bench(args: argparse.Namespace) -> int:
    import time

    from datatrust import config
    from datatrust.bench.harness import run_bench, trial_specs
    from datatrust.bench.metrics import summarize
    from datatrust.bench.report import write_report
    from datatrust.bench.scenarios import SCENARIOS
    from datatrust.rca_cli import rca

    if args.what == "summaries":
        return _bench_summaries(args)
    if args.mode == "e2e":
        return _bench_e2e(args)
    seeds = _parse_seeds(args.seeds)
    scenario_ids = args.scenarios.split(",") if args.scenarios else None
    t0 = time.perf_counter()
    records = run_bench(
        trial_specs(seeds, scenario_ids, clean=not args.no_clean),
        work_dir=Path(args.work_dir) if args.work_dir else None,
        workers=args.workers,
        keep=args.keep,
    )
    wall = time.perf_counter() - t0
    loso = None
    if args.dev_results:
        dev = json.loads(Path(args.dev_results).read_text())["records"]
        loso = rca("loso", {"dev": _tune_trials(dev), "test": _tune_trials(records)})
    summary = summarize(records, loso)
    weights = rca("weights", {})
    command = "uv run datatrust " + " ".join(sys.argv[1:]) if not args.command_label else args.command_label
    jpath, mpath = write_report(
        records,
        summary,
        out_dir=Path(args.out) if args.out else config.RESULTS_DIR,
        mode=args.mode,
        seeds=seeds,
        command=command,
        wall_seconds=wall,
        weights=weights,
        tag=args.tag,
        scenario_titles={s.id: s.title for s in SCENARIOS},
    )
    print(mpath.read_text())
    print(json.dumps({"json": str(jpath), "md": str(mpath)}))
    if args.gate:
        from datatrust.bench.metrics import gate

        problems = gate(summary, json.loads(Path(args.gate).read_text()))
        for problem in problems:
            print(f"GATE FAILED: {problem}", file=sys.stderr)
        if problems:
            return 1
        print("gate passed", file=sys.stderr)
    return 0


def _bench_summaries(args: argparse.Namespace) -> int:
    from datatrust import config
    from datatrust.bench.summaries import evaluate_summaries, write_summary_report

    seeds = _parse_seeds(args.seeds if args.seeds != "101-105" else "101")
    report = evaluate_summaries(seeds[0], args.provider, llm_url=args.llm_url, workers=args.workers or 4)
    command = args.command_label or "uv run datatrust " + " ".join(sys.argv[1:])
    jpath, mpath = write_summary_report(report, Path(args.out) if args.out else config.RESULTS_DIR, command)
    print(mpath.read_text())
    print(json.dumps({"json": str(jpath), "md": str(mpath)}))
    return 0 if report["summary"]["piiLeaks"] == 0 else 1


def _bench_e2e(args: argparse.Namespace) -> int:
    import os
    import time

    from datatrust import config
    from datatrust.bench.e2e import parity, run_e2e
    from datatrust.bench.harness import run_bench, trial_specs
    from datatrust.bench.report import write_e2e_report
    from datatrust.bench.scenarios import SCENARIOS

    seeds = _parse_seeds(args.seeds)
    scenario_ids = args.scenarios.split(",") if args.scenarios else [s.id for s in SCENARIOS]
    base_url = os.environ.get("DATATRUST_API_URL", "http://127.0.0.1:8792")
    t0 = time.perf_counter()
    records = run_e2e(seeds, scenario_ids, base_url=base_url)
    wall = time.perf_counter() - t0
    mismatches = None
    if args.parity:
        offline = run_bench(
            trial_specs(seeds, scenario_ids, clean=False), workers=args.workers, progress=False
        )
        mismatches = parity(records, offline)
    command = args.command_label or "uv run datatrust " + " ".join(sys.argv[1:])
    jpath, mpath = write_e2e_report(
        records,
        out_dir=Path(args.out) if args.out else config.RESULTS_DIR,
        seeds=seeds,
        command=command,
        wall_seconds=wall,
        parity=mismatches,
        tag=args.tag,
    )
    print(mpath.read_text())
    print(json.dumps({"json": str(jpath), "md": str(mpath)}))
    return 1 if mismatches else 0


def _cmd_tune(args: argparse.Namespace) -> int:
    from datatrust.rca_cli import rca

    report = json.loads(Path(args.from_path).read_text())
    seeds = set(report["meta"]["seeds"])
    if not seeds <= {1, 2, 3}:
        print(f"refusing to tune on non-dev seeds {sorted(seeds)} (ADR-0004)", file=sys.stderr)
        return 2
    best = rca("tune", {"trials": _tune_trials(report["records"])})
    print(json.dumps(best, indent=2))
    return 0


def _cmd_baseline(args: argparse.Namespace) -> int:
    from datatrust.bench.metrics import baseline_from

    report = json.loads(Path(args.from_path).read_text())
    meta = report["meta"]
    out = {
        **baseline_from(report["summary"]),
        "seeds": meta["seeds"],
        "date": meta["date"],
        "command": meta["command"],
        "gitCommit": meta["gitCommit"],
        "warehouse": meta["warehouse"],
        "weights": meta["weights"],
        "report": Path(args.from_path).name,
    }
    Path(args.out).write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0


def _cmd_runner(args: argparse.Namespace) -> int:
    import logging

    from datatrust.runner.client import WorkerClient
    from datatrust.runner.loop import run_once, watch

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    client = WorkerClient.from_env("runner", args.env)
    kinds = args.kinds.split(",")
    if args.once:
        report = run_once(client, target=args.target, kinds=kinds)
        print(json.dumps(report))
        return 0
    watch(client, target=args.target, kinds=kinds, max_jobs=args.max_jobs, idle_exit=args.idle_exit)
    return 0


def _cmd_restore(args: argparse.Namespace) -> int:
    """Local stand-in for BigQuery time travel: copy a mart snapshot into <node>_restored_<ts>."""
    import datetime as dt
    import re

    import duckdb

    from datatrust import config

    if not re.match(r"^[A-Za-z0-9_]+$", args.run) or not re.match(r"^[a-z_][a-z0-9_]*$", args.node):
        print("unsafe run id or node name", file=sys.stderr)
        return 2
    snap = config.snapshot_dir() / args.run / f"{args.node}.parquet"
    if not snap.exists():
        print(f"no snapshot at {snap}", file=sys.stderr)
        return 1
    db = Path(args.duckdb_path).resolve() if args.duckdb_path else config.duckdb_path()
    stamp = dt.datetime.now(dt.UTC).strftime("%Y%m%d%H%M%S")
    table = f"{args.node}_restored_{stamp}"
    with duckdb.connect(str(db)) as con:
        con.execute(f'create table "marts"."{table}" as select * from read_parquet(?)', [str(snap)])
        n = con.execute(f'select count(*) from "marts"."{table}"').fetchone()
    print(json.dumps({"restored": f"marts.{table}", "rows": n[0] if n else 0, "from": str(snap)}))
    return 0


def _cmd_lake(args: argparse.Namespace) -> int:
    if args.lake_command == "sync":
        from datatrust.lake.sync import sync
        from datatrust.runner.client import WorkerClient

        print(json.dumps(sync(WorkerClient.from_env("runner", "local"))))
        return 0
    import duckdb

    from datatrust.lake.iceberg_local import read

    events = read()
    con = duckdb.connect()
    con.register("audit_events", events)
    sql = args.sql or "select event_type, count(*) as events from audit_events group by 1 order by 1"
    cur = con.execute(sql)
    cols = [d[0] for d in cur.description or []]
    for row in cur.fetchall():
        print(json.dumps(dict(zip(cols, row, strict=True)), default=str))
    return 0


def _cmd_prod(args: argparse.Namespace) -> int:
    from datatrust.prod.settings import NotConfigured

    try:
        if args.prod_command == "governance":
            from datatrust.prod import governance
            from datatrust.prod.settings import GcpSettings

            settings = GcpSettings.from_env()
            if args.action == "apply":
                import os

                email = os.environ.get("DATATRUST_OPERATOR_EMAIL")
                if not email:
                    raise NotConfigured(
                        "set DATATRUST_OPERATOR_EMAIL in .env.prod (your Google account email)"
                    )
                state = governance.apply(settings, email)
                print(json.dumps(state.__dict__, indent=2))
                return 0
            results = governance.verify(settings)
            print(json.dumps(results, indent=2))
            return 0 if all(r["ok"] for r in results) else 1
        if args.prod_command == "validate":
            from datatrust.prod.validate import main as validate_main

            return validate_main()
        if args.prod_command == "smoke":
            from datatrust.prod.smoke import smoke

            report = smoke(skip_validate=args.skip_validate)
            print(
                json.dumps(
                    {k: report.get(k) for k in ("ok", "clean_ok", "workers_ai_incidents", "fallback_rate")}
                )
            )
            return 0 if report.get("ok") else 1
        if args.prod_command == "reset":
            if not args.yes:
                print("refusing without --yes: this deletes DataTrust tables in BigQuery", file=sys.stderr)
                return 2
            from google.cloud import bigquery

            from datatrust.prod.settings import DATASETS, GcpSettings

            settings = GcpSettings.from_env()
            client = bigquery.Client(project=settings.project, location=settings.location)
            for ds in DATASETS:
                for t in client.list_tables(f"{settings.project}.{ds}"):
                    client.delete_table(t, not_found_ok=True)
                    print(f"deleted {t.full_table_id}")
            return 0
    except NotConfigured as err:
        print(f"not configured: {err}", file=sys.stderr)
        return 2
    return 2


def _cmd_doctor(args: argparse.Namespace) -> int:
    from datatrust.doctor import main as doctor_main

    return doctor_main("prod" if args.prod else "local")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="datatrust", description=__doc__)
    parser.add_argument("--version", action="version", version=f"datatrust {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="command")

    p = sub.add_parser("synth", help="generate the seeded synthetic workforce dataset as Parquet")
    p.add_argument("--seed", type=int, required=True)
    p.add_argument("--out", help="output directory (default .data/raw/<seed>/)")
    p.set_defaults(func=_cmd_synth)

    p = sub.add_parser("load", help="load a generated dataset into the warehouse as raw sources")
    p.add_argument("--seed", type=int, required=True)
    p.add_argument("--target", choices=["duckdb", "bigquery"], default="duckdb")
    p.add_argument("--raw-dir", help="Parquet directory (default .data/raw/<seed>/, generated if missing)")
    p.add_argument("--duckdb-path", help=DUCKDB_HELP)
    p.set_defaults(func=_cmd_load)

    p = sub.add_parser("build", help="dbt-ol build: models, contracts, 40 checks, OpenLineage events")
    p.add_argument("--duckdb-path", help=DUCKDB_HELP)
    p.add_argument("--target-path", help="dbt target directory (default dbt/target)")
    p.add_argument("--verbose", action="store_true", help="print dbt output")
    p.set_defaults(func=_cmd_build)

    p = sub.add_parser(
        "bench", help="fault-injection benchmark (SPEC 12); `bench summaries` evaluates summaries"
    )
    p.add_argument("what", nargs="?", choices=["trials", "summaries"], default="trials")
    p.add_argument("--mode", choices=["offline", "e2e"], default="offline")
    p.add_argument(
        "--provider", choices=["template", "local-llm"], default="template", help="bench summaries only"
    )
    p.add_argument(
        "--llm-url", default="http://127.0.0.1:8160", help="bench summaries with --provider local-llm"
    )
    p.add_argument("--seeds", default="101-105", help="e.g. 101-105 or 1,2,3")
    p.add_argument("--scenarios", help="comma-separated scenario ids (default: all 20)")
    p.add_argument("--no-clean", action="store_true", help="skip the clean trial per seed")
    p.add_argument("--workers", type=int, help="parallel trials (default min(4, cpus/2))")
    p.add_argument("--out", help="results directory (default results/)")
    p.add_argument("--tag", help="suffix for the report file name")
    p.add_argument("--dev-results", help="dev-seed report JSON; enables the leave-one-scenario-out figure")
    p.add_argument("--work-dir", help="scratch directory for trials (default .data/bench)")
    p.add_argument("--keep", action="store_true", help="keep each trial's warehouse and dbt target")
    p.add_argument("--gate", help="baseline JSON; fail on clean false positives or a drop of more than 0.05")
    p.add_argument("--parity", action="store_true", help="e2e: also run the offline trials and compare top-3")
    p.add_argument("--command-label", help=argparse.SUPPRESS)
    p.set_defaults(func=_cmd_bench)

    p = sub.add_parser("tune", help="grid-search ranking weights on a dev-seed report (ADR-0004)")
    p.add_argument("--from", dest="from_path", required=True)
    p.set_defaults(func=_cmd_tune)

    p = sub.add_parser("runner", help="lease and run jobs from the Worker (SPEC 14)")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="run at most one job")
    mode.add_argument("--watch", action="store_true", help="keep leasing (default)")
    p.add_argument("--env", choices=["local", "prod"], default="local")
    p.add_argument("--target", choices=["duckdb", "bigquery"], default="duckdb")
    p.add_argument("--kinds", default="dbt_build,diagnostics")
    p.add_argument("--max-jobs", type=int)
    p.add_argument("--idle-exit", type=float, help="stop after this many seconds without a job")
    p.set_defaults(func=_cmd_runner)

    p = sub.add_parser("restore", help="restore a mart from a local Parquet snapshot (time-travel stand-in)")
    p.add_argument("--from-snapshot", dest="run", required=True, help="run id of the green run")
    p.add_argument("node", help="mart model name, e.g. fct_hires")
    p.add_argument("--duckdb-path", help=DUCKDB_HELP)
    p.set_defaults(func=_cmd_restore)

    p = sub.add_parser("lake", help="local Iceberg lake (pyiceberg SQL catalog stand-in for Basin Catalog)")
    lake = p.add_subparsers(dest="lake_command", required=True)
    lake.add_parser("sync", help="append the local Worker's audit events to the local Iceberg table")
    q = lake.add_parser("query", help="query the local Iceberg table with DuckDB")
    q.add_argument("--sql", help="SQL over the table audit_events")
    p.set_defaults(func=_cmd_lake)

    p = sub.add_parser("prod", help="production path: governance, validate, smoke, reset (needs .env.prod)")
    prod = p.add_subparsers(dest="prod_command", required=True)
    g = prod.add_parser("governance", help="BigQuery taxonomy, policy tags, masking and IAM")
    g.add_argument("action", choices=["apply", "verify"])
    prod.add_parser(
        "validate", help="compile, build --empty, probe dry runs and banned-construct check on BigQuery"
    )
    sm = prod.add_parser("smoke", help="end-to-end production smoke; writes results/prod-smoke-<date>.*")
    sm.add_argument("--skip-validate", action="store_true")
    rs = prod.add_parser("reset", help="delete the DataTrust tables in the four BigQuery datasets")
    rs.add_argument("--yes", action="store_true")
    p.set_defaults(func=_cmd_prod)

    p = sub.add_parser("doctor", help="check prerequisites and print exactly what is missing (SPEC 18.2)")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--local", action="store_true", help="local and CI prerequisites (default)")
    mode.add_argument(
        "--prod", action="store_true", help="Cloudflare and Google Cloud production prerequisites"
    )
    p.set_defaults(func=_cmd_doctor)

    p = sub.add_parser("baseline", help="extract the gate numbers from a benchmark report")
    p.add_argument("--from", dest="from_path", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=_cmd_baseline)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
