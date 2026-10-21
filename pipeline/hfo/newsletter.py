"""Newsletter: a weekly English summary written from two snapshots.

Issue N compares the Monday export with the one seven days earlier, so
archived issues never change. A rolling "last 7 days" issue compares the most
recent snapshot with the one closest to a week before it.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from email.utils import format_datetime
from xml.sax.saxutils import escape

from .common import rows
from .sources import MONDAY_MAJOR, version_day
from .trends import closest_before, parse_ts

SITE_URL = os.environ.get("SITE_URL", "https://ernes-cloud.github.io/hf-observatory/")
MAX_ISSUES = 26

TASK_SPECIAL = {"any-to-any": "any-to-any", "text2text-generation": "text-to-text generation"}
LICENSE_LABEL = {"oss": "open license", "non-commercial": "non-commercial", "unknown": "unclear license"}


# ---------------------------------------------------------------- formatting
def n(x: int | float | None) -> str:
    return "–" if x is None else f"{x:,.0f}"


def compact(x: int | float | None) -> str:
    if x is None:
        return "–"
    ax = abs(x)
    for div, suf in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if ax >= div:
            v = x / div
            return f"{v:.1f}".rstrip("0").rstrip(".") + suf
    return f"{x:,.0f}"


def pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def plural(k: int, word: str, many: str | None = None) -> str:
    return f"{n(k)} {word if k == 1 else (many or word + 's')}"


def task(t: str | None) -> str:
    if not t:
        return "model"
    return TASK_SPECIAL.get(t, t.replace("-", " "))


def params(p: float | None) -> str:
    if not p:
        return ""
    return f"{p / 1e9:.1f}B".replace(".0B", "B") if p >= 1e9 else f"{p / 1e6:.0f}M"


def day(d: datetime) -> str:
    return f"{d:%b} {d.day}, {d.year}"


def span(a: datetime, b: datetime) -> str:
    if a.year == b.year:
        return f"{a:%b} {a.day} – {b:%b} {b.day}, {b.year}"
    return f"{day(a)} – {day(b)}"


def hf(id_: str) -> str:
    return f"https://huggingface.co/{id_}"


# ---------------------------------------------------------------- content
def issue(con, snaps: list[dict], old: int, new: int) -> dict:
    a, b = parse_ts(snaps[old]["snapshot_at"]), parse_ts(snaps[new]["snapshot_at"])
    ts_a, ts_b = a.strftime("%Y-%m-%d %H:%M:%S"), b.strftime("%Y-%m-%d %H:%M:%S")
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW nw AS
        SELECT b.* FROM (SELECT * FROM h WHERE s = {new}) b
        ANTI JOIN (SELECT id FROM h WHERE s = {old}) a USING (id)""")
    # created on the Hub inside the window (vs merely newly tracked by the radar)
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW fresh AS
        SELECT * FROM nw WHERE created_at > TIMESTAMPTZ '{ts_a}+00' AND created_at <= TIMESTAMPTZ '{ts_b}+00'""")
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW gone AS
        SELECT b.*, coalesce(a.downloads_30d, b.downloads_30d) AS last_downloads
        FROM (SELECT * FROM h WHERE s = {new} AND removed) b
        LEFT JOIN (SELECT * FROM h WHERE s = {old}) a USING (id)
        WHERE (a.id IS NULL OR NOT a.removed) AND b.removed_at > TIMESTAMPTZ '{ts_a}+00'""")
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW moves AS
        SELECT b.id, b.author, b.pipeline_tag, a.downloads_30d AS old, b.downloads_30d AS new,
               b.downloads_30d - a.downloads_30d AS delta
        FROM (SELECT * FROM h WHERE s = {new} AND NOT removed) b
        JOIN (SELECT * FROM h WHERE s = {old} AND NOT removed) a USING (id)""")

    stats = rows(con, f"""
        SELECT (SELECT count(*) FROM nw) AS newly_tracked,
               (SELECT count(*) FROM fresh) AS created,
               (SELECT count(*) FROM gone) AS removed,
               (SELECT count(*) FROM h WHERE s = {new} AND NOT removed) AS live_now,
               (SELECT count(*) FROM h WHERE s = {old} AND NOT removed) AS live_before,
               (SELECT count(DISTINCT author) FROM fresh) AS new_authors_active,
               (SELECT avg((license_family = 'oss')::INT) FROM fresh) AS fresh_open_share,
               (SELECT avg(gated::INT) FROM fresh) AS fresh_gated_share""")[0]

    cols = "id, author, pipeline_tag AS task, parameters, license_family AS lf, downloads_30d AS downloads, likes, family"
    top_new = rows(con, f"SELECT {cols} FROM fresh ORDER BY downloads_30d DESC, likes DESC LIMIT 10")
    liked_new = rows(con, f"SELECT {cols} FROM fresh WHERE likes > 0 ORDER BY likes DESC LIMIT 5")
    removals = rows(con, """SELECT id, author, pipeline_tag AS task, last_downloads AS downloads, likes, gated,
                                   license_family AS lf, strftime(created_at, '%Y-%m-%d') AS created
                            FROM gone ORDER BY last_downloads DESC, likes DESC LIMIT 8""")
    removers = rows(con, "SELECT author, count(*) AS models FROM gone GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 5")
    rising = rows(con, "SELECT id, author, pipeline_tag AS task, old, new, delta FROM moves WHERE delta > 0 ORDER BY delta DESC LIMIT 8")
    fading = rows(con, "SELECT id, author, pipeline_tag AS task, old, new, delta FROM moves WHERE delta < 0 ORDER BY delta LIMIT 5")
    publishers = rows(con, "SELECT author, count(*) AS models, sum(downloads_30d) AS downloads FROM fresh GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 6")
    fam = rows(con, "SELECT coalesce(family, 'Other / undetected') AS family, count(*) AS models FROM fresh GROUP BY 1 ORDER BY 2 DESC LIMIT 7")
    tasks = rows(con, "SELECT pipeline_tag AS task, count(*) AS models FROM fresh WHERE pipeline_tag IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5")

    # Titles use the day encoded in the version (exports run early in the morning,
    # so the data's own timestamps can fall on the previous evening in UTC).
    da, db = (datetime.combine(version_day(s["major"]), datetime.min.time()) if s.get("major") else t
              for s, t in ((snaps[old], a), (snaps[new], b)))
    title = f"Week of {span(da, db)}"
    intro = _intro(stats, top_new, removals, rising, publishers)
    data = {
        "title": title,
        "from": snaps[old]["snapshot_at"], "to": snaps[new]["snapshot_at"],
        "from_tag": snaps[old]["tag"], "to_tag": snaps[new]["tag"],
        "stats": stats, "intro": intro,
        "top_new": top_new, "liked_new": liked_new, "removals": removals, "removers": removers,
        "rising": rising, "fading": fading, "publishers": publishers, "families": fam, "tasks": tasks,
    }
    data["markdown"] = to_markdown(data)
    return data


def _intro(stats, top_new, removals, rising, publishers) -> list[str]:
    p = []
    net = stats["live_now"] - stats["live_before"]
    p.append(
        f"{plural(stats['created'], 'new model')} created on the Hub this week made it onto the radar, "
        f"from {plural(stats['new_authors_active'], 'publisher')}. "
        f"{plural(stats['removed'], 'model')} disappeared, and the number of live tracked models "
        f"{'grew' if net >= 0 else 'shrank'} by {n(abs(net))} to {n(stats['live_now'])}."
    )
    if top_new:
        t = top_new[0]
        size = params(t["parameters"])
        p.append(
            f"The week's most downloaded newcomer is {t['id']}, a {size + ' ' if size else ''}{task(t['task'])} "
            f"model with {compact(t['downloads'])} downloads already."
        )
    if publishers:
        pub = publishers[0]
        p.append(f"The busiest publisher was {pub['author']}, with {plural(pub['models'], 'new model')}.")
    if rising:
        r = rising[0]
        p.append(f"Among established models, {r['id']} gained the most ground (+{compact(r['delta'])} downloads over the 30-day window).")
    if removals and removals[0]["downloads"]:
        g = removals[0]
        p.append(f"The most notable removal was {g['id']}, which had {compact(g['downloads'])} downloads before it vanished.")
    if stats["fresh_open_share"] is not None:
        p.append(f"{pct(stats['fresh_open_share'])} of this week's new models carry an open license that allows commercial use.")
    return p


def _model_line(m: dict, extra: str) -> str:
    bits = [b for b in (task(m.get("task")) if m.get("task") else None, params(m.get("parameters"))) if b]
    return f"[{m['id']}]({hf(m['id'])})" + (f" ({', '.join(bits)})" if bits else "") + f" — {extra}"


def to_markdown(d: dict) -> str:
    out = [f"# HF Observatory weekly: {d['title']}", ""]
    out += [" ".join(d["intro"]), ""]
    s = d["stats"]
    out += ["## In numbers", "",
            f"- **{n(s['created'])}** new models created on the Hub (and {n(s['newly_tracked'])} newly tracked in total)",
            f"- **{n(s['removed'])}** models removed",
            f"- **{n(s['live_now'])}** live models tracked ({'+' if s['live_now'] >= s['live_before'] else '−'}{n(abs(s['live_now'] - s['live_before']))})", ""]
    if d["top_new"]:
        out += ["## Top new models", ""]
        out += [f"{i}. " + _model_line(m, f"{compact(m['downloads'])} downloads, {plural(m['likes'], 'like')}, {LICENSE_LABEL.get(m['lf'], m['lf'])}") for i, m in enumerate(d["top_new"], 1)]
        out.append("")
    if d["liked_new"]:
        out += ["## Most liked newcomers", ""]
        out += [f"- " + _model_line(m, plural(m['likes'], 'like')) for m in d["liked_new"]]
        out.append("")
    if d["rising"]:
        out += ["## Notable moves", "", "Biggest gains in 30-day downloads among models already tracked a week ago:", ""]
        out += [f"- [{m['id']}]({hf(m['id'])}): {compact(m['old'])} → {compact(m['new'])} (+{compact(m['delta'])})" for m in d["rising"]]
        if d["fading"]:
            out += ["", "Biggest drops:", ""]
            out += [f"- [{m['id']}]({hf(m['id'])}): {compact(m['old'])} → {compact(m['new'])} (−{compact(abs(m['delta']))})" for m in d["fading"]]
        out.append("")
    if d["removals"]:
        out += ["## Removals", ""]
        out += [f"- {m['id']} — {compact(m['downloads'])} downloads before removal" + (", gated" if m["gated"] else "") + (", unclear license" if m["lf"] == "unknown" else "") for m in d["removals"]]
        if d["removers"]:
            out += ["", "Publishers removing the most: " + ", ".join(f"{r['author']} ({r['models']})" for r in d["removers"]) + "."]
        out.append("")
    if d["publishers"]:
        out += ["## Most active publishers", ""]
        out += [f"- [{p['author']}](https://huggingface.co/{p['author']}): {plural(p['models'], 'new model')}" for p in d["publishers"]]
        out.append("")
    if d["families"]:
        out += ["## New models by family", "", ", ".join(f"{f['family']} {n(f['models'])}" for f in d["families"]) + ".", ""]
    out += ["---", "",
            f"Compared releases {d['from_tag']} and {d['to_tag']} of "
            "[radar-huggingface-dataset](https://github.com/686f6c61/radar-huggingface-dataset) (CC-BY-4.0). "
            f"Generated automatically by [HF Observatory]({SITE_URL}#newsletter).", ""]
    return "\n".join(out)


def build(con, snaps: list[dict]) -> tuple[dict, dict[str, dict], str]:
    """Returns (index, {slug: issue}, rss_xml). Requires table ``h`` from trends.load_history."""
    issues: dict[str, dict] = {}
    last = len(snaps) - 1
    # Fixed weekly issues: Monday → Monday (numbered releases with major ≡ MONDAY_MAJOR mod 7).
    mondays = [i for i, s in enumerate(snaps) if s.get("major") is not None and (s["major"] - MONDAY_MAJOR) % 7 == 0]
    for i in mondays:
        old = next((j for j in range(i) if snaps[j].get("major") == snaps[i]["major"] - 7), None)
        if old is None:
            continue
        slug = parse_ts(snaps[i]["snapshot_at"]).strftime("%Y-%m-%d")
        issues[slug] = issue(con, snaps, old, i) | {"slug": slug, "kind": "weekly"}
    # Rolling issue for the most recent week, unless it coincides with a weekly one.
    if not mondays or mondays[-1] != last:
        old = closest_before(snaps, last, 7)
        if old is not None:
            d = issue(con, snaps, old, last)
            d["title"] = f"Last 7 days ({d['title'].removeprefix('Week of ')})"
            d["markdown"] = to_markdown(d)
            issues["latest"] = d | {"slug": "latest", "kind": "rolling"}

    order = sorted(issues.values(), key=lambda d: d["to"], reverse=True)[:MAX_ISSUES]
    index = {"issues": [{k: d[k] for k in ("slug", "title", "from", "to", "kind")} | {"summary": d["intro"][0]} for d in order]}
    return index, {d["slug"]: d for d in order}, rss(order)


def rss(order: list[dict]) -> str:
    items = []
    for d in order:
        if d["kind"] != "weekly":
            continue
        pub = parse_ts(d["to"]).replace(tzinfo=timezone.utc)
        link = f"{SITE_URL}#newsletter?issue={d['slug']}"
        items.append(
            f"<item><title>{escape(d['title'])}</title><link>{escape(link)}</link>"
            f"<guid isPermaLink=\"false\">hf-observatory-{d['slug']}</guid>"
            f"<pubDate>{format_datetime(pub)}</pubDate>"
            f"<description>{escape(' '.join(d['intro']))}</description></item>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>'
        "<title>HF Observatory weekly</title>"
        f"<link>{SITE_URL}#newsletter</link>"
        "<description>Weekly summary of new, removed and rising models on the Hugging Face Hub, "
        "built from radar-huggingface-dataset (CC-BY-4.0).</description><language>en</language>"
        + "".join(items) + "</channel></rss>\n"
    )

