"""`datatrust` command line entry point."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from datatrust import __version__


def _cmd_synth(args: argparse.Namespace) -> int:
    from datatrust import config
    from datatrust.synth.generator import generate, write_dataset

    out = Path(args.out) if args.out else config.raw_dir(args.seed)
    ds = generate(args.seed)
    m = write_dataset(ds, out)
    print(json.dumps({"out": str(out), "total_rows": m["total_rows"], "seed": args.seed}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="datatrust", description=__doc__)
    parser.add_argument("--version", action="version", version=f"datatrust {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="command")

    p = sub.add_parser("synth", help="generate the seeded synthetic workforce dataset as Parquet")
    p.add_argument("--seed", type=int, required=True)
    p.add_argument("--out", help="output directory (default .data/raw/<seed>/)")
    p.set_defaults(func=_cmd_synth)

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
