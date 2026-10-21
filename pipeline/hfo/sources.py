"""Download the radar-huggingface-dataset bulk files and turn them into slim snapshots.

The bulk ``models.jsonl.gz`` is ~250 MB because every line embeds a Spanish
model card. We never keep it: each download is streamed into DuckDB, reduced
to the columns the site needs and written as a small Parquet file, then the
``.gz`` is deleted. Numbered releases are immutable, so their snapshots are
cached forever (``CACHE_DIR/snapshots``) and a daily run only fetches what is new.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import duckdb

from .families import family_case_sql

REPO = "686f6c61/radar-huggingface-dataset"
REPO_URL = f"https://github.com/{REPO}"
ASSET = "models.jsonl.gz"

# Columns kept for the current ("latest") state. Everything except the
# embedded card (`ficha`) and the web sources.
LATEST_COLUMNS = """
    id, author, url, created_at, updated_at, license, license_family, pipeline_tag,
    library, languages, tags, likes, downloads_30d, trending_score, parameters,
    storage_bytes, base_model, formats, is_conversational, gated, removed, removed_at,
    len(benchmarks) AS n_benchmarks, to_json(benchmarks) AS benchmarks_json
"""

# Columns kept for historical snapshots (trends + newsletter).
SNAPSHOT_COLUMNS = """
    id, author, created_at, updated_at, pipeline_tag, license_family, likes, downloads_30d,
    trending_score, parameters, gated, removed, removed_at
"""


def log(msg: str) -> None:
    print(f"[hfo] {msg}", file=sys.stderr, flush=True)


@dataclass(frozen=True, order=True)
class Version:
    major: int
    minor: int
    patch: int

    @property
    def tag(self) -> str:
        return f"v{self.major}.{self.minor}.{self.patch}"

    @classmethod
    def parse(cls, tag: str) -> "Version | None":
        m = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", tag)
        return cls(*map(int, m.groups())) if m else None


def list_versions() -> list[Version]:
    """All numbered release tags, oldest first (uses `git ls-remote`, no API token needed)."""
    out = subprocess.run(
        ["git", "ls-remote", "--tags", "--refs", f"{REPO_URL}.git"],
        check=True, capture_output=True, text=True,
    ).stdout
    versions = {Version.parse(line.split("refs/tags/")[-1]) for line in out.splitlines()}
    return sorted(v for v in versions if v)


# The major version counts days since the dataset started; v61 was Monday
# 2026-10-19, so majors with (major - 61) % 7 == 0 are Mondays. Weekly
# snapshots (and newsletter issues) are aligned on them.
MONDAY_MAJOR = 61
MONDAY_DATE = date(2026, 10, 19)


def version_day(major: int) -> date:
    return MONDAY_DATE + timedelta(days=major - MONDAY_MAJOR)


def snapshot_time(meta: dict) -> str:
    """Export time of a numbered release.

    Normally the most recent timestamp in the data. Releases rebuilt after a
    worker outage (v29–v34) all carry the rebuild time instead, so when the data
    disagrees with the day encoded in the version we trust the version
    (morning export ≈ 04:00 UTC).
    """
    day = version_day(meta["major"])
    data_ts = datetime.strptime(meta["snapshot_at"], "%Y-%m-%dT%H:%M:%SZ")
    if abs(data_ts.date() - day) <= timedelta(days=1) and data_ts.date() <= day:
        return meta["snapshot_at"]
    return f"{day.isoformat()}T04:00:00Z"


def pick_history(versions: list[Version], daily_days: int, max_snapshots: int) -> list[Version]:
    """One version per day (the first export of each day): daily for the most
    recent ``daily_days`` days, Mondays only before that, capped at ``max_snapshots``."""
    first_of_day: dict[int, Version] = {}
    for v in versions:
        first_of_day.setdefault(v.major, v)
    majors = sorted(first_of_day)
    if not majors:
        return []
    newest = majors[-1]
    picked = [m for m in majors if newest - m < daily_days or (m - MONDAY_MAJOR) % 7 == 0]
    return [first_of_day[m] for m in picked[-max_snapshots:]]


def asset_url(tag: str) -> str:
    return f"{REPO_URL}/releases/download/{tag}/{ASSET}"


def download(url: str, dest: Path, attempts: int = 4) -> bool:
    """Download ``url`` to ``dest``. Returns False on 404 (release without asset)."""
    for i in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=120) as resp, open(dest, "wb") as fh:
                while chunk := resp.read(1 << 20):
                    fh.write(chunk)
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
        wait = 2 ** (i + 1)
        log(f"download failed ({err}); retrying in {wait}s")
        time.sleep(wait)
    raise RuntimeError(f"could not download {url}")


def _read_bulk_sql(path: Path) -> str:
    return (
        f"read_json('{path.as_posix()}', format='newline_delimited', "
        "maximum_object_size=67108864)"
    )


def _snapshot_time(con: duckdb.DuckDBPyConnection, table: str) -> str:
    """Approximate export time: the most recent timestamp found in the data."""
    row = con.execute(
        f"""SELECT strftime(greatest(max(updated_at), max(created_at), max(removed_at)),
                            '%Y-%m-%dT%H:%M:%SZ') FROM {table}"""
    ).fetchone()
    return row[0]


def build_latest(cache: Path, keep_gz: Path | None = None) -> tuple[Path, dict]:
    """Download the floating ``latest`` bulk and write ``latest.parquet``."""
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / "latest.parquet"
    gz = keep_gz
    tmp = None
    if gz is None:
        tmp = tempfile.TemporaryDirectory(dir=cache)
        gz = Path(tmp.name) / ASSET
        log("downloading latest bulk")
        if not download(asset_url("latest"), gz):
            raise RuntimeError("latest release has no models.jsonl.gz")
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    con.execute("SET enable_progress_bar=false")
    con.execute(
        f"""CREATE TABLE m AS SELECT {LATEST_COLUMNS},
                {family_case_sql()} AS family
            FROM {_read_bulk_sql(gz)}"""
    )
    meta = {"snapshot_at": _snapshot_time(con, "m"), "models": con.execute("SELECT count(*) FROM m").fetchone()[0]}
    con.execute(f"COPY m TO '{out.as_posix()}' (FORMAT parquet, COMPRESSION zstd)")
    con.close()
    if tmp:
        tmp.cleanup()
    log(f"latest: {meta['models']:,} models, snapshot {meta['snapshot_at']}")
    return out, meta


def build_snapshot(version: Version, cache: Path) -> dict | None:
    """Ensure the slim snapshot of ``version`` exists in the cache; return its metadata."""
    snap_dir = cache / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    out = snap_dir / f"{version.tag}.parquet"
    meta_path = snap_dir / f"{version.tag}.json"
    if out.exists() and meta_path.exists():
        return json.loads(meta_path.read_text())
    missing = snap_dir / f"{version.tag}.missing"
    if missing.exists():
        return None
    with tempfile.TemporaryDirectory(dir=cache) as tmp:
        gz = Path(tmp) / ASSET
        log(f"downloading {version.tag}")
        if not download(asset_url(version.tag), gz):
            log(f"{version.tag} has no bulk asset; skipping")
            missing.touch()
            return None
        con = duckdb.connect()
        con.execute("SET TimeZone='UTC'")
        con.execute("SET enable_progress_bar=false")
        con.execute(
            f"""CREATE TABLE m AS SELECT {SNAPSHOT_COLUMNS}, {family_case_sql()} AS family
                FROM {_read_bulk_sql(gz)}"""
        )
        meta = {
            "tag": version.tag,
            "major": version.major,
            "snapshot_at": _snapshot_time(con, "m"),
            "models": con.execute("SELECT count(*) FROM m").fetchone()[0],
        }
        con.execute(f"COPY m TO '{out.as_posix()}' (FORMAT parquet, COMPRESSION zstd)")
        con.close()
    meta_path.write_text(json.dumps(meta))
    return meta


def build_history(cache: Path, daily_days: int, max_snapshots: int) -> list[dict]:
    """Snapshots used for trends and the newsletter, oldest first."""
    versions = list_versions()
    log(f"{len(versions)} numbered releases found")
    metas = []
    for v in pick_history(versions, daily_days, max_snapshots):
        meta = build_snapshot(v, cache)
        if meta:
            meta["major"] = v.major
            meta["data_snapshot_at"] = meta["snapshot_at"]
            meta["snapshot_at"] = snapshot_time(meta)
            meta["path"] = str(cache / "snapshots" / f"{v.tag}.parquet")
            metas.append(meta)
    metas.sort(key=lambda m: m["snapshot_at"])
    return metas


def env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))
