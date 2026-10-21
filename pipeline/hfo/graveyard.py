"""Graveyard: models that disappeared from the Hub (``removed``)."""

from __future__ import annotations

from .common import rows

LIFESPAN_BUCKETS = [
    ("Under 1 day", 1),
    ("1–7 days", 7),
    ("1–4 weeks", 28),
    ("1–3 months", 91),
    ("3–12 months", 365),
    ("1–2 years", 730),
    ("2+ years", None),
]

MODEL_COLUMNS = ["id", "task", "lf", "license", "gated", "created", "removed_at", "lifespan", "downloads", "likes", "params"]


def _lifespan_case(col: str) -> str:
    parts = [f"WHEN {col} IS NULL THEN 'Unknown'"]
    for label, upper in LIFESPAN_BUCKETS:
        parts.append(f"ELSE '{label}'" if upper is None else f"WHEN {col} < {upper} THEN '{label}'")
    return "CASE " + " ".join(parts) + " END"


def build(con) -> dict:
    con.execute("""
        CREATE OR REPLACE TEMP VIEW dead AS
        SELECT *, epoch(removed_at - created_at) / 86400.0 AS lifespan FROM m WHERE removed""")

    totals = rows(con, """
        SELECT count(*) FILTER (WHERE removed) AS removed,
               count(*) AS tracked,
               median(epoch(removed_at - created_at) / 86400.0) FILTER (WHERE removed) AS median_lifespan_days,
               avg(gated::INT) FILTER (WHERE removed) AS gated_share_removed,
               avg(gated::INT) FILTER (WHERE NOT removed) AS gated_share_live,
               avg((license_family = 'unknown')::INT) FILTER (WHERE removed) AS unclear_share_removed,
               avg((license_family = 'unknown')::INT) FILTER (WHERE NOT removed) AS unclear_share_live,
               count(*) FILTER (WHERE removed AND downloads_30d >= 1000) AS removed_with_traction,
               strftime(min(removed_at), '%Y-%m-%d') AS first_detected,
               strftime(max(removed_at), '%Y-%m-%d') AS last_detected
        FROM m""")[0]

    by_author = rows(con, """
        SELECT author, count(*) FILTER (WHERE removed) AS removed, count(*) AS tracked,
               sum(downloads_30d) FILTER (WHERE removed) AS downloads
        FROM m GROUP BY author HAVING count(*) FILTER (WHERE removed) > 0
        ORDER BY removed DESC, downloads DESC LIMIT 20""")

    order = {label: i for i, (label, _) in enumerate(LIFESPAN_BUCKETS)}
    lifespan = rows(con, f"""
        SELECT {_lifespan_case('lifespan')} AS bucket, count(*) AS models FROM dead GROUP BY 1""")
    lifespan.sort(key=lambda r: order.get(r["bucket"], 99))

    per_week = rows(con, """
        SELECT strftime(date_trunc('week', removed_at), '%Y-%m-%d') AS week, count(*) AS models,
               count(*) FILTER (WHERE gated) AS gated
        FROM dead GROUP BY 1 ORDER BY 1""")

    license_cmp = rows(con, """
        SELECT license_family AS family,
               count(*) FILTER (WHERE removed) AS removed,
               count(*) FILTER (WHERE NOT removed) AS live
        FROM m GROUP BY 1 ORDER BY removed DESC""")

    by_task = rows(con, """
        SELECT coalesce(pipeline_tag, 'unspecified') AS task,
               count(*) FILTER (WHERE removed) AS removed, count(*) AS tracked
        FROM m GROUP BY 1 HAVING count(*) FILTER (WHERE removed) > 0
        ORDER BY removed DESC LIMIT 15""")

    by_family = rows(con, """
        SELECT family, count(*) FILTER (WHERE removed) AS removed, count(*) AS tracked
        FROM m WHERE family IS NOT NULL GROUP BY 1 ORDER BY removed DESC LIMIT 15""")

    models = rows(con, """
        SELECT id, pipeline_tag AS task, license_family AS lf, license, gated,
               strftime(created_at, '%Y-%m-%d') AS created, strftime(removed_at, '%Y-%m-%d') AS removed_at,
               round(lifespan, 1) AS lifespan, downloads_30d AS downloads, likes,
               round(parameters / 1e6, 1) AS params
        FROM dead ORDER BY downloads_30d DESC, likes DESC, removed_at DESC""")

    return {
        "totals": totals,
        "by_author": by_author,
        "lifespan": lifespan,
        "per_week": per_week,
        "license": license_cmp,
        "by_task": by_task,
        "by_family": by_family,
        "notable": models[:15],
        "models": {
            "columns": MODEL_COLUMNS,
            "rows": [[m[c] for c in MODEL_COLUMNS] for m in models],
        },
    }
