"""Build the site's data files.

    python pipeline/build.py --out web/data

Environment / flags:
    --cache DIR          where downloads and snapshots are kept (default pipeline/.cache)
    --latest-gz FILE     use a local models.jsonl.gz instead of downloading `latest`
    --history-days N     daily snapshots for the last N days, weekly before (default 35)
    --max-snapshots N    cap on historical snapshots (default 60)
    --no-history         skip the historical releases (Trends/Newsletter left empty)
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hfo import finder, overview  # noqa: E402
from hfo.common import connect, write_json  # noqa: E402
from hfo.sources import REPO, build_latest, list_versions, log  # noqa: E402

ROOT = Path(__file__).resolve().parent


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ROOT.parent / "web" / "data")
    ap.add_argument("--cache", type=Path, default=ROOT / ".cache")
    ap.add_argument("--latest-gz", type=Path)
    ap.add_argument("--history-days", type=int, default=35)
    ap.add_argument("--max-snapshots", type=int, default=60)
    ap.add_argument("--no-history", action="store_true")
    args = ap.parse_args(argv)

    t0 = time.time()
    latest_path, meta = build_latest(args.cache, args.latest_gz)
    meta.update({
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": f"https://github.com/{REPO}",
        "license": "CC-BY-4.0",
    })
    try:
        versions = list_versions()
        meta["release"] = versions[-1].tag if versions else None
    except Exception as e:  # network hiccup: the release tag is informative only
        log(f"could not list releases: {e}")
        versions = []

    con = connect()
    con.execute(f"CREATE TABLE m AS SELECT * FROM '{latest_path.as_posix()}'")

    out = args.out
    sizes = {}
    sizes["overview.json"] = write_json(out / "overview.json", overview.build(con, meta))
    sizes["finder.json"] = write_json(out / "finder.json", finder.build(con))
    sizes["meta.json"] = write_json(out / "meta.json", meta)

    for name, n in sizes.items():
        log(f"wrote {name}: {n / 1024:,.0f} KB")
    log(f"done in {time.time() - t0:,.0f}s")


if __name__ == "__main__":
    main()
