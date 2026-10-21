"""Overview: a snapshot of the whole ecosystem."""

from __future__ import annotations

from .common import SIZE_BUCKETS, rows, scalar, size_bucket_sql

TOP_N = 15


def build(con, meta: dict) -> dict:
    """``con`` has a table ``m`` with the latest state."""
    con.execute("CREATE OR REPLACE TEMP VIEW live AS SELECT * FROM m WHERE NOT removed")
    now = f"TIMESTAMPTZ '{meta['snapshot_at']}'"

    totals = rows(con, f"""
        SELECT count(*) AS tracked,
               count(*) FILTER (WHERE NOT removed) AS live,
               count(*) FILTER (WHERE removed) AS removed,
               count(*) FILTER (WHERE gated AND NOT removed) AS gated,
               count(*) FILTER (WHERE license_family = 'oss' AND NOT removed) AS open_license,
               count(*) FILTER (WHERE license_family = 'non-commercial' AND NOT removed) AS non_commercial,
               count(DISTINCT author) FILTER (WHERE NOT removed) AS authors,
               sum(downloads_30d) FILTER (WHERE NOT removed) AS downloads_30d,
               count(*) FILTER (WHERE NOT removed AND created_at >= {now} - INTERVAL 7 DAY) AS created_7d
        FROM m""")[0]

    top_orgs_count = rows(con, f"""
        SELECT author, count(*) AS models, sum(downloads_30d) AS downloads
        FROM live GROUP BY author ORDER BY models DESC, downloads DESC LIMIT {TOP_N}""")
    top_orgs_downloads = rows(con, f"""
        SELECT author, sum(downloads_30d) AS downloads, count(*) AS models
        FROM live GROUP BY author ORDER BY downloads DESC LIMIT {TOP_N}""")

    tasks = rows(con, """
        SELECT coalesce(pipeline_tag, 'unspecified') AS task, count(*) AS models,
               sum(downloads_30d) AS downloads
        FROM live GROUP BY 1 ORDER BY models DESC""")

    licenses = rows(con, """
        SELECT license_family AS family, count(*) AS models, sum(downloads_30d) AS downloads
        FROM live GROUP BY 1 ORDER BY models DESC""")
    raw_licenses = rows(con, f"""
        SELECT coalesce(license, 'not declared') AS license, any_value(license_family) AS family,
               count(*) AS models
        FROM live GROUP BY 1 ORDER BY models DESC LIMIT {TOP_N}""")

    order = {label: i for i, (label, _) in enumerate(SIZE_BUCKETS)}
    sizes = rows(con, f"""
        SELECT {size_bucket_sql()} AS bucket, count(*) AS models, sum(downloads_30d) AS downloads
        FROM live GROUP BY 1""")
    sizes.sort(key=lambda r: order.get(r["bucket"], 99))

    formats = rows(con, """
        SELECT f AS format, count(*) AS models, sum(downloads_30d) AS downloads
        FROM (SELECT unnest(formats) AS f, downloads_30d FROM live) GROUP BY 1 ORDER BY models DESC""")
    no_format = scalar(con, "SELECT count(*) FROM live WHERE len(formats) = 0")

    languages = rows(con, """
        SELECT lang, count(*) AS models
        FROM (SELECT unnest(languages) AS lang FROM live) GROUP BY 1 ORDER BY models DESC LIMIT 20""")
    no_language = scalar(con, "SELECT count(*) FROM live WHERE len(languages) = 0")

    # Models created per ISO week (live and since-removed), last 52 complete-or-current weeks.
    weekly = rows(con, f"""
        WITH w AS (
            SELECT date_trunc('week', created_at)::DATE AS week, removed FROM m
            WHERE created_at >= date_trunc('week', {now}) - INTERVAL 51 WEEK
        )
        SELECT strftime(week, '%Y-%m-%d') AS week, count(*) AS models,
               count(*) FILTER (WHERE removed) AS removed
        FROM w GROUP BY week ORDER BY week""")

    families = rows(con, """
        SELECT family, count(*) AS models, sum(downloads_30d) AS downloads
        FROM live WHERE family IS NOT NULL GROUP BY 1 ORDER BY downloads DESC""")

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
