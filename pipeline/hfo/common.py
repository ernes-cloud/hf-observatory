"""Shared helpers for the section builders."""

from __future__ import annotations

import json
import math
from pathlib import Path

import duckdb

# Parameter-count buckets used across the site (upper bounds, exclusive).
SIZE_BUCKETS: list[tuple[str, float]] = [
    ("< 1B", 1e9),
    ("1–4B", 4e9),
    ("4–9B", 9e9),
    ("9–16B", 16e9),
    ("16–35B", 35e9),
    ("35–80B", 80e9),
    ("80–200B", 200e9),
    ("200B+", math.inf),
]


def size_bucket_sql(col: str = "parameters") -> str:
    parts = [f"WHEN {col} IS NULL THEN 'Unknown'"]
    for label, upper in SIZE_BUCKETS:
        if math.isinf(upper):
            parts.append(f"ELSE '{label}'")
        else:
            parts.append(f"WHEN {col} < {upper:.0f} THEN '{label}'")
    return "CASE " + " ".join(parts) + " END"


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    con.execute("SET enable_progress_bar=false")
    return con


def rows(con: duckdb.DuckDBPyConnection, sql: str, params: list | None = None) -> list[dict]:
    """Run ``sql`` and return a list of dicts (timestamps should be cast to text in SQL)."""
    cur = con.execute(sql, params or [])
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def scalar(con: duckdb.DuckDBPyConnection, sql: str, params: list | None = None):
    return con.execute(sql, params or []).fetchone()[0]


def _clean(obj):
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return round(obj, 4)
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if hasattr(obj, "is_integer") and not isinstance(obj, (int, bool)):
        return float(obj)  # Decimal
    return obj


def write_json(path: Path, data) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(_clean(data), separators=(",", ":"), ensure_ascii=False, default=str)
    path.write_text(text, encoding="utf-8")
    return len(text)
