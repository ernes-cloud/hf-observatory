"""Overview: a snapshot of the whole ecosystem."""

from __future__ import annotations

from .common import SIZE_BUCKETS, rows, scalar, size_bucket_sql

TOP_N = 15
# "Publishes the most" counts models people actually use, so experiment dumps don't lead the list.
TRACTION = "(downloads_30d >= 100 OR likes >= 3)"


def build(con, meta: dict) -> dict:
    """``con`` has a table ``m`` with the latest state."""
    # Breakdowns count "signal" models: live and not flagged as noise (sweeps, course exercises,
    # test repos, uploads with no traction after a week; see quality.py). Downloads use ``dl``,
    # which counts a download figure copied across sibling repos only once.
    con.execute("CREATE OR REPLACE TEMP VIEW live AS SELECT * FROM m WHERE NOT removed")
    con.execute("CREATE OR REPLACE TEMP VIEW signal AS SELECT * FROM live WHERE NOT noise")
    now = f"TIMESTAMPTZ '{meta['snapshot_at']}'"
    start = meta.get("tracking_start", "2026-08-19")

    totals = rows(con, f"""
        SELECT count(*) AS tracked,
               count(*) FILTER (WHERE NOT removed) AS live,
               count(*) FILTER (WHERE removed) AS removed,
               count(*) FILTER (WHERE gated AND NOT removed) AS gated,
               count(*) FILTER (WHERE NOT removed AND NOT noise) AS signal,
               count(*) FILTER (WHERE NOT removed AND noise) AS noise,
               count(*) FILTER (WHERE license_family = 'oss' AND NOT removed) AS open_license,
               count(*) FILTER (WHERE license_family = 'conditional' AND NOT removed) AS conditional_license,
               count(*) FILTER (WHERE license_family = 'unknown' AND NOT removed) AS unknown_license,
               count(*) FILTER (WHERE license_family = 'non-commercial' AND NOT removed) AS non_commercial,
               count(DISTINCT author) FILTER (WHERE NOT removed) AS authors,
               sum(dl) FILTER (WHERE NOT removed) AS downloads_30d,
               sum(downloads_30d - dl) FILTER (WHERE NOT removed) AS copied_downloads,
               count(*) FILTER (WHERE created_at < TIMESTAMPTZ '{start}') AS before_tracking,
               count(*) FILTER (WHERE NOT removed AND created_at >= {now} - INTERVAL 7 DAY) AS created_7d,
               count(*) FILTER (WHERE NOT removed AND nullif(trim(base_model), '') IS NOT NULL) AS derived,
               median(epoch(removed_at - created_at) / 86400.0) FILTER (WHERE removed) AS removed_median_days,
               avg((removed_at - created_at < INTERVAL 7 DAY)::INT) FILTER (WHERE removed) AS removed_within_week
        FROM m""")[0]

    top_orgs_count = rows(con, f"""
        SELECT author, count(*) FILTER (WHERE {TRACTION}) AS models, count(*) AS all_models, sum(dl) AS downloads
        FROM signal GROUP BY author ORDER BY models DESC, downloads DESC LIMIT {TOP_N}""")
    top_orgs_downloads = rows(con, f"""
        SELECT author, sum(dl) AS downloads, count(*) AS models
        FROM live GROUP BY author ORDER BY downloads DESC LIMIT {TOP_N}""")

    tasks = rows(con, """
        SELECT coalesce(pipeline_tag, 'unspecified') AS task, count(*) AS models,
               sum(dl) AS downloads
        FROM signal GROUP BY 1 ORDER BY models DESC""")

    licenses = rows(con, """
        SELECT license_family AS family, count(*) AS models, sum(dl) AS downloads
        FROM signal GROUP BY 1 ORDER BY models DESC""")
    raw_licenses = rows(con, f"""
        SELECT coalesce(license, 'not declared') AS license, any_value(license_family) AS family,
               count(*) AS models
        FROM signal GROUP BY 1 ORDER BY models DESC LIMIT {TOP_N}""")

    order = {label: i for i, (label, _) in enumerate(SIZE_BUCKETS)}
    sizes = rows(con, f"""
        SELECT {size_bucket_sql()} AS bucket, count(*) AS models, sum(dl) AS downloads
        FROM signal GROUP BY 1""")
    sizes.sort(key=lambda r: order.get(r["bucket"], 99))

    formats = rows(con, """
        SELECT f AS format, count(*) AS models, sum(dl) AS downloads
        FROM (SELECT unnest(formats) AS f, dl FROM signal) GROUP BY 1 ORDER BY models DESC""")
    no_format = scalar(con, "SELECT count(*) FROM signal WHERE len(formats) = 0")

    languages = rows(con, """
        SELECT lang, count(*) AS models
        FROM (SELECT unnest(languages) AS lang FROM signal) GROUP BY 1 ORDER BY models DESC LIMIT 20""")
    no_language = scalar(con, "SELECT count(*) FROM signal WHERE len(languages) = 0")

    # Models created per ISO week (live and since-removed), from the week the radar started
    # tracking: earlier weeks only hold the few older models it picked up later.
    weekly = rows(con, f"""
        WITH w AS (
            SELECT date_trunc('week', created_at)::DATE AS week, removed, noise FROM m
            WHERE created_at >= greatest(date_trunc('week', TIMESTAMPTZ '{start}'),
                                         date_trunc('week', {now}) - INTERVAL 51 WEEK)
        )
        SELECT strftime(week, '%Y-%m-%d') AS week, count(*) AS models,
               count(*) FILTER (WHERE removed) AS removed, count(*) FILTER (WHERE noise) AS noise
        FROM w GROUP BY week ORDER BY week""")

    families = rows(con, """
        SELECT family, count(*) AS models, sum(dl) AS downloads
        FROM signal WHERE family IS NOT NULL GROUP BY 1 ORDER BY downloads DESC""")

    top_models = rows(con, """
        SELECT id, pipeline_tag AS task, downloads_30d AS downloads, likes
        FROM live ORDER BY downloads_30d DESC LIMIT 10""")

    return {
        "meta": meta,
        "totals": totals,
        "top_orgs_by_count": top_orgs_count,
        "top_orgs_by_downloads": top_orgs_downloads,
        "tasks": tasks,
        "license_families": licenses,
        "licenses": raw_licenses,
        "sizes": sizes,
        "formats": formats,
        "no_format": no_format,
        "languages": languages,
        "no_language": no_language,
        "created_per_week": weekly,
        "families": families,
        "top_models": top_models,
    }
