"""Trends: how downloads evolve across past releases.

All metrics compare rolling 30-day download counts between snapshots, and
only for models present in both snapshots, so the radar adding more models
over time does not show up as "growth".
"""

from __future__ import annotations

from datetime import datetime, timedelta

from .common import rows

WINDOWS = (7, 14, 30)
TOP = 20
FAMILY_SERIES = 8  # one categorical colour per family; the rest folds into "Other"


def parse_ts(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")


def load_history(con, snapshots: list[dict], latest_meta: dict) -> list[dict]:
    """Create table ``h`` (one row per model per snapshot, column ``s`` = snapshot index).

    The current ``latest`` state is appended as the final snapshot when it is
    newer than the last numbered release we have.
    """
    snaps = [dict(s) for s in snapshots]
    parts = [
        f"SELECT {i} AS s, id, author, pipeline_tag, license_family, parameters, likes, downloads_30d, "
        f"trending_score, removed, removed_at, created_at, gated, family FROM '{s['path']}'"
        for i, s in enumerate(snaps)
    ]
    last = parse_ts(snaps[-1]["snapshot_at"]) if snaps else None
    if last is None or parse_ts(latest_meta["snapshot_at"]) - last > timedelta(hours=3):
        snaps.append({"tag": latest_meta.get("release") or "latest", "snapshot_at": latest_meta["snapshot_at"],
                      "models": latest_meta["models"], "latest": True})
        parts.append(
            f"SELECT {len(snaps) - 1} AS s, id, author, pipeline_tag, license_family, parameters, likes, "
            "downloads_30d, trending_score, removed, removed_at, created_at, gated, family FROM m"
        )
    con.execute("CREATE OR REPLACE TABLE h AS " + " UNION ALL ".join(parts))
    for i, s in enumerate(snaps):
        s["index"] = i
    return snaps


def closest_before(snaps: list[dict], end: int, days: int, tolerance_days: float = 1.6) -> int | None:
    """Index of the snapshot closest to ``days`` before snapshot ``end``."""
    target = parse_ts(snaps[end]["snapshot_at"]) - timedelta(days=days)
    best = min(range(end), key=lambda i: abs(parse_ts(snaps[i]["snapshot_at"]) - target), default=None)
    if best is None:
        return None
    if abs(parse_ts(snaps[best]["snapshot_at"]) - target) > timedelta(days=tolerance_days):
        return None
    return best


def movers(con, old: int, new: int, limit: int = TOP) -> dict:
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW pair AS
        SELECT b.id, b.author, b.pipeline_tag AS task, b.family, a.downloads_30d AS old, b.downloads_30d AS new,
               b.downloads_30d - a.downloads_30d AS delta,
               (b.downloads_30d + 1.0) / (a.downloads_30d + 1.0) AS ratio
        FROM (SELECT * FROM h WHERE s = {new} AND NOT removed) b
        JOIN (SELECT * FROM h WHERE s = {old}) a USING (id)""")
    cols = "id, author, task, family, old, new, delta, ratio"
    rising = rows(con, f"SELECT {cols} FROM pair WHERE delta > 0 ORDER BY delta DESC LIMIT {limit}")
    breakout = rows(con, f"""SELECT {cols} FROM pair WHERE new >= 5000 AND old >= 500 AND ratio >= 1.5
                             ORDER BY ratio DESC LIMIT {limit}""")
    fading = rows(con, f"SELECT {cols} FROM pair WHERE delta < 0 ORDER BY delta ASC LIMIT {limit}")
    orgs = rows(con, """
        SELECT author, sum(old) AS old, sum(new) AS new, sum(new) - sum(old) AS delta, count(*) AS models
        FROM pair GROUP BY author""")
    orgs_rising = sorted((o for o in orgs if o["delta"] > 0), key=lambda o: -o["delta"])[:15]
    orgs_fading = sorted((o for o in orgs if o["delta"] < 0), key=lambda o: o["delta"])[:15]
    newcomers = rows(con, f"""
        SELECT b.id, b.author, b.pipeline_tag AS task, b.family, b.downloads_30d AS new
        FROM (SELECT * FROM h WHERE s = {new} AND NOT removed) b
        ANTI JOIN (SELECT id FROM h WHERE s = {old}) a USING (id)
        ORDER BY b.downloads_30d DESC LIMIT {limit}""")
    return {"rising": rising, "breakout": breakout, "fading": fading,
            "orgs_rising": orgs_rising, "orgs_fading": orgs_fading, "newcomers": newcomers}


def build(con, snapshots: list[dict], latest_meta: dict) -> tuple[dict, list[dict]]:
    """Returns (trends.json payload, snapshot list as loaded into table ``h``)."""
    snaps = load_history(con, snapshots, latest_meta)
    last = len(snaps) - 1

    # Ecosystem-wide series
    totals = rows(con, """
        SELECT s, count(*) FILTER (WHERE NOT removed) AS live, count(*) FILTER (WHERE removed) AS removed,
               sum(downloads_30d) FILTER (WHERE NOT removed) AS downloads
        FROM h GROUP BY s ORDER BY s""")

    # Family adoption (top families by current downloads; the rest → Other)
    fam_rank = [r["family"] for r in rows(con, f"""
        SELECT family FROM h WHERE s = {last} AND NOT removed AND family IS NOT NULL
        GROUP BY family ORDER BY sum(downloads_30d) DESC LIMIT {FAMILY_SERIES - 1}""")]
    fam_rows = rows(con, """
        SELECT s, family, count(*) AS models, sum(downloads_30d) AS downloads
        FROM h WHERE NOT removed AND family IS NOT NULL GROUP BY s, family""")
    families = {f: {"models": [0] * len(snaps), "downloads": [0] * len(snaps)} for f in fam_rank + ["Other"]}
    for r in fam_rows:
        key = r["family"] if r["family"] in fam_rank else "Other"
        families[key]["models"][r["s"]] += r["models"]
        families[key]["downloads"][r["s"]] += r["downloads"] or 0

    windows = {}
    for days in WINDOWS:
        old = closest_before(snaps, last, days)
        if old is None:
            continue
        windows[str(days)] = {"from": old, "to": last, **movers(con, old, last)}

    # Series (downloads per snapshot) for every model appearing in a list, plus the current leaders.
    leaders = rows(con, f"""SELECT id, downloads_30d AS downloads, pipeline_tag AS task FROM h
                            WHERE s = {last} AND NOT removed ORDER BY downloads_30d DESC LIMIT 10""")
    trending = rows(con, f"""SELECT id, author, pipeline_tag AS task, trending_score AS score, downloads_30d AS downloads
                             FROM h WHERE s = {last} AND NOT removed AND trending_score > 0
                             ORDER BY trending_score DESC LIMIT {TOP}""")
    ids = {m["id"] for m in leaders + trending}
    for w in windows.values():
        for key in ("rising", "breakout", "fading", "newcomers"):
            ids.update(m["id"] for m in w[key])
    series_rows = rows(con, """
        SELECT id, list(s ORDER BY s) AS s, list(downloads_30d ORDER BY s) AS dl, list(trending_score ORDER BY s) AS tr
        FROM h WHERE id IN (SELECT unnest(?)) GROUP BY id""", [sorted(ids)])
    series = {}
    trend_series = {}
    trending_ids = {m["id"] for m in trending}
    for r in series_rows:
        dl = [None] * len(snaps)
        for s, v in zip(r["s"], r["dl"]):
            dl[s] = v
        series[r["id"]] = dl
        if r["id"] in trending_ids:
            tr = [None] * len(snaps)
            for s, v in zip(r["s"], r["tr"]):
                tr[s] = round(v or 0, 1)
            trend_series[r["id"]] = tr

    return {
        "snapshots": [{"tag": s["tag"], "date": s["snapshot_at"], "models": s["models"]} for s in snaps],
        "totals": totals,
        "families": families,
        "windows": windows,
        "leaders": leaders,
        "trending": trending,
        "series": series,
        "trending_series": trend_series,
    }, snaps
