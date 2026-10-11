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
    from datatrust.dbt.build import run_dbt

    db = Path(args.duckdb_path).resolve() if args.duckdb_path else config.duckdb_path()
    res = run_dbt(["build"], target_path=config.DBT_DIR / "target", duckdb_path=db)
    print(res.stdout)
    return res.returncode


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

    p = sub.add_parser("build", help="dbt build against the loaded warehouse")
    p.add_argument("--duckdb-path", help=DUCKDB_HELP)
    p.set_defaults(func=_cmd_build)

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
