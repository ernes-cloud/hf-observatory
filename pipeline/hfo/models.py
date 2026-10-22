"""Per-model pages: one record for every tracked model (live or removed), in 256 shards.

The site's model page (``#model?id=…``) fetches the one shard that holds the model, so a
page costs ~40 KB instead of the whole finder index. The shard is picked by a 32-bit FNV-1a
hash of the lowercased id (``web/js/models.js`` computes the same hash).

A record holds the model's metadata, its download history across snapshots (weekly, then
daily for the last two weeks; only for models that ever reached ``HISTORY_MIN`` downloads),
its parents and derivatives, and the benchmarks published on its card.

``search.json`` is the header search's index: the most downloaded models, the publishers
and the families, enough to suggest as you type without loading the finder.
"""

from __future__ import annotations

import json
from collections import defaultdict

from .common import rows
from .finder import MEMORY_SQL
from .sources import MONDAY_MAJOR
from .trees import RELATIONS, _edges

SHARDS = 256
HISTORY_MIN = 100  # downloads; below that a history line says nothing
DAILY = 14  # the last DAILY snapshots are kept daily, older ones on Mondays only
TOP_CHILDREN = 8
SEARCH_MODELS = 8_000
SEARCH_AUTHORS = 2_000


def shard_of(model_id: str) -> int:
    h = 0x811C9DC5
    for ch in model_id.lower():
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h % SHARDS


def _history_points(snaps: list[dict]) -> list[int]:
    last = len(snaps) - 1
    return [i for i, s in enumerate(snaps)
            if last - i < DAILY or s.get("major") is None or (s["major"] - MONDAY_MAJOR) % 7 == 0]


def build(con, snaps: list[dict]) -> tuple[dict, dict[int, dict], dict]:
    """Returns (models/index.json, {shard: {id_lower: record}}, search.json)."""
    models = rows(con, f"""
        SELECT id, author, pipeline_tag AS task, license_family AS lf, license, library, languages, formats,
               parameters, storage_bytes, nullif(trim(base_model), '') AS base_model, tags, family,
               downloads_30d AS dl, likes, trending_score, gated, is_conversational, noise,
               strftime(created_at, '%Y-%m-%d') AS created, strftime(updated_at, '%Y-%m-%d') AS updated,
               removed, strftime(removed_at, '%Y-%m-%d') AS removed_at, removal_kind, successor,
               benchmarks_json, ({MEMORY_SQL}) / 1e9 AS mem_gb
        FROM m""")
    live = [m for m in models if not m["removed"]]
    info = {m["id"].lower(): m for m in models}
    children = _edges(live)

    # Download history, thinned to weekly points plus the last two weeks.
    points = _history_points(snaps) if snaps else []
    pos = {s: k for k, s in enumerate(points)}
    history: dict[str, list] = {}
    if points:
        hist_rows = rows(con, f"""
            SELECT lower(id) AS k, list(s ORDER BY s) AS s, list(downloads_30d ORDER BY s) AS dl
            FROM h WHERE s IN (SELECT unnest(?)) AND id IN (
                SELECT id FROM h GROUP BY id HAVING max(downloads_30d) >= {HISTORY_MIN})
            GROUP BY 1""", [points])
        for r in hist_rows:
            series = [None] * len(points)
            for s, v in zip(r["s"], r["dl"]):
                series[pos[s]] = v
            history[r["k"]] = series

    shards: dict[int, dict] = defaultdict(dict)
    for m in models:
        key = m["id"].lower()
        rec = {
            "id": m["id"], "t": m["task"], "lf": m["lf"], "lic": m["license"], "lib": m["library"],
            "lang": m["languages"] or [], "fmt": m["formats"] or [], "fam": m["family"],
            "p": m["parameters"], "sb": m["storage_bytes"], "dl": m["dl"], "lk": m["likes"],
            "tr": round(m["trending_score"] or 0, 1), "c": m["created"], "u": m["updated"],
            "mem": round(m["mem_gb"], 1) if m["mem_gb"] is not None else None,
        }
        flags = [k for k, v in (("gated", m["gated"]), ("chat", m["is_conversational"]), ("noise", m["noise"])) if v]
        if flags:
            rec["fl"] = flags
        if m["removed"]:
            rec["rm"] = m["removed_at"]
            rec["rk"] = m["removal_kind"]
            if m["successor"]:
                rec["sc"] = m["successor"]
        parents = []
        for tag in m["tags"] or []:
            parts = tag.split(":", 2)
            if len(parts) == 3 and parts[0] == "base_model" and parts[1] in RELATIONS and parts[2].strip():
                parents.append([parts[2].strip(), parts[1]])
        if not parents and m["base_model"]:
            parents = [[p.strip(), "derivative"] for p in m["base_model"].split(",") if p.strip()]
        if parents:
            rec["par"] = parents[:4]
        kids = children.get(key, [])
        if kids:
            by_rel = {r: 0 for r in RELATIONS}
            for _, rel in kids:
                by_rel[rel] += 1
            rec["kids"] = {r: n for r, n in by_rel.items() if n}
            top = sorted(kids, key=lambda kr: -((info.get(kr[0].lower()) or {}).get("dl") or 0))[:TOP_CHILDREN]
            rec["top"] = [[cid, rel, (info.get(cid.lower()) or {}).get("dl") or 0] for cid, rel in top]
        if m["benchmarks_json"]:
            try:
                bench = json.loads(m["benchmarks_json"])
            except ValueError:
                bench = []
            rec["bm"] = [[b.get("task"), b.get("dataset"), b.get("metric"), b.get("value")]
                         for b in bench[:12] if isinstance(b, dict) and b.get("value") is not None]
            if not rec["bm"]:
                del rec["bm"]
        if key in history:
            rec["h"] = history[key]
        shards[shard_of(m["id"])][key] = rec

    index = {"shards": SHARDS, "dates": [snaps[i]["snapshot_at"] for i in points]}

    ranked = sorted((m for m in live if not m["noise"]), key=lambda m: -(m["dl"] or 0))[:SEARCH_MODELS]
    authors: dict[str, list] = defaultdict(lambda: [0, 0])
    for m in live:
        a = authors[m["author"]]
        a[0] += 1
        a[1] += m["dl"] or 0
    families: dict[str, int] = defaultdict(int)
    for m in live:
        if m["family"]:
            families[m["family"]] += 1
    search = {
        "models": [m["id"] for m in ranked],
        "authors": [[a, n] for a, (n, _) in sorted(authors.items(), key=lambda kv: -kv[1][1])[:SEARCH_AUTHORS]],
        "families": [[f, n] for f, n in sorted(families.items(), key=lambda kv: -kv[1])],
    }
    return index, dict(shards), search
