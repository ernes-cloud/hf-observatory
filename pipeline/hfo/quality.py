"""Data-quality layer applied to the latest table before any section is built.

The radar copies what the Hub reports, and some of it misleads when counted naively:

* **Licenses.** The dataset's ``license_family`` calls Llama, Gemma, OpenRAIL and even
  ``qwen-research`` licenses "oss". We reclassify every license into four classes:
  ``oss`` (open source, commercial use allowed), ``conditional`` (open weights under custom
  terms: usage policies, user caps, attribution...), ``non-commercial`` and ``unknown``.
* **Parameters.** Packed 4-bit / NVFP4 weights and draft files make the Hub count far
  smaller than the model (a 27B GGUF counted as 0.46B); a size written in the name wins.
* **Tasks.** Free-text pipeline tags ("Decisions", "Heart rate") are dropped.
* **Noise.** Seed / step / checkpoint sweeps, course exercises (ppo-LunarLander...), test
  fixtures and uploads with no downloads or likes after a week are flagged ``noise`` and kept
  out of rankings and counts that would otherwise be dominated by them.
* **Copied download counts.** Sibling repos of one author sometimes report the exact same
  30-day downloads (GGUF and "uncensored" variants, V7…V12 of one merge). Only the most
  liked one counts in totals (``dl``); the others get 0 there but keep their own figure.
* **Removals.** A removed model is ``replaced`` when its author published a near-identical
  name around the same time, ``rehosted`` when the same repo name is live under another
  account, ``cleanup`` when it never had traction, else ``removed``.
"""

from __future__ import annotations

import json
import os
import re
import tempfile

from .families import family_case_sql

# ------------------------------------------------------------------ licenses
OPEN_TOKENS = (
    r"apache(-license)?-2\.0|mit|bsd(-[23]-clause(-clear)?)?|isc|zlib|unlicense|wtfpl|cc0-1\.0|"
    r"cc-by-(sa-)?[234]\.0|mpl-2\.0|epl-2\.0|[al]?gpl-[23]\.0(-only|-or-later)?|lgpl-[23]\.0|afl-3\.0|osl-3\.0|"
    r"artistic-2\.0|odc-by|cdla-(permissive|sharing)-[12]\.0|openmdw-?1\.[01](-license)?|bsl-1\.0|eupl-1\.2|ecl-2\.0|pddl"
)
OPEN_RX = re.compile(rf"^(mixed-)?({OPEN_TOKENS})((-and-|-|\+)({OPEN_TOKENS}))*$")
NONCOMMERCIAL_RX = re.compile(
    r"(^|-)nc(-|$)|non-?commercial|research|internal|proprietary|all-rights-reserved|"
    r"polyform-(strict|noncommercial)|card-only|weights-not-released|evaluation-only|academic"
)
UNDECLARED = {"", "unknown", "other", "mixed", "per-model", "cc", "mixed-see-readme", "see-readme", "custom", "none"}


def license_class(license: str | None) -> str:
    """oss | conditional | non-commercial | unknown."""
    lic = (license or "").strip().lower()
    if lic in UNDECLARED:
        return "unknown"
    if NONCOMMERCIAL_RX.search(lic):
        return "non-commercial"
    if OPEN_RX.match(lic):
        return "oss"
    # Everything else is a named custom license (llama3.1, gemma, openrail, *-community-license,
    # nvidia-open-model-license...): weights are open but the terms add conditions.
    return "conditional"


# ------------------------------------------------------------------ sizes
NAMED_SIZE_RX = re.compile(r"(?:^|[-_/. ])(\d+(?:\.\d+)?)b(?=$|[-_. ])", re.I)
# Repos that are genuinely small although the name carries the base model's size.
SMALL_PART_RX = re.compile(r"dspark|dflash|eagle|(^|[-_.])mtp([-_.]|$)|draft|lora|adapter|probe|reward|head", re.I)
UUID_RX = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-", re.I)
UNDERSCORE_DECIMAL_RX = re.compile(r"(?<![\d.])(\d)_(\d)b", re.I)
MILLIONS_RX = re.compile(r"(?:^|[-_/. ])\d+(?:\.\d+)?m(?=$|[-_. ])", re.I)


def named_params(model_id: str | None) -> float | None:
    """The first size written in the repo name in billions (``27B``, ``1.5B``), in parameters.
    The first one is the model's own size: later ones are usually the active share or a base."""
    name = (model_id or "").split("/")[-1]
    if UUID_RX.search(name) or MILLIONS_RX.search(name):
        return None  # "-350m-...-15b": the b figure is training tokens, not the size
    name = UNDERSCORE_DECIMAL_RX.sub(r"\1.\2b", name)  # "qwen3_0_6b" writes 0.6B with an underscore
    m = NAMED_SIZE_RX.search(name)
    if not m:
        return None
    v = float(m.group(1)) * 1e9
    return v if 1e8 <= v <= 3e12 else None


def fixed_params(model_id: str | None, parameters: int | None) -> int | None:
    named = named_params(model_id)
    if named and (not parameters or parameters < named * 0.3) and not SMALL_PART_RX.search((model_id or "").split("/")[-1]):
        return int(named)
    return parameters


# ------------------------------------------------------------------ noise
SWEEP_RX = r"(seed|ckpt|checkpoint|step|epoch|iter|run|trial)[-_]?[0-9]+|ablation|sweep|[-_]s[0-9]{3,}$"
COURSE_RX = (
    r"^(ppo|dqn|a2c|q|reinforce|sac|td3|poca)-(lunarlander|huggy|snowballtarget|pyramids|spaceinvaders|"
    r"frozenlake|taxi|pandareach|pandapickandplace|cartpole|pixelcopter|soccertwos|walker|ant|halfcheetah)|"
    r"^(my[-_]?awesome[-_]?model|mytestrepo|my[-_]test[-_]repo|myawesomemodel[-_]?testrepo|test[-_]?repo|tds-carbon-card)"
)
TEST_RX = r"internal-testing|(^|[-_/])tiny-random|(^|[-_])dummy([-_]|$)|^test[-_]|[-_]test$"
TASK_RX = r"^[a-z0-9]+(-[a-z0-9]+)*$"


def apply(con, snapshot_at: str) -> dict:
    """Rewrite table ``m`` in place with the corrected columns plus ``noise``, ``dl``,
    ``removal_kind`` and ``successor``. Returns counts for the build log and meta.json."""
    # The rules live in Python (and are unit-tested there); their results join back as tables.
    lic = [(x, license_class(x)) for (x,) in con.execute("SELECT DISTINCT license FROM m").fetchall()]
    _table(con, "lic_class", ["license VARCHAR", "cls VARCHAR"], lic)
    sizes = [(i, fixed_params(i, p)) for i, p in con.execute("SELECT id, parameters FROM m").fetchall()]
    _table(con, "size_fix", ["id VARCHAR", "p BIGINT"], [(i, p) for (i, p), (_, old) in
                                                           zip(sizes, con.execute("SELECT id, parameters FROM m").fetchall()) if p != old])
    now = f"TIMESTAMPTZ '{snapshot_at}'"
    name = "lower(split_part(id, '/', 2))"
    con.execute(f"""
        CREATE OR REPLACE TABLE m AS
        WITH base AS (
            SELECT m.* REPLACE (
                       coalesce(lic_class.cls, 'unknown') AS license_family,
                       coalesce(size_fix.p, m.parameters) AS parameters,
                       CASE WHEN regexp_matches(m.pipeline_tag, '{TASK_RX}') THEN m.pipeline_tag END AS pipeline_tag,
                       {family_case_sql('m.id', 'm.base_model')} AS family),
                   m.parameters AS parameters_reported
            FROM m LEFT JOIN lic_class ON lic_class.license IS NOT DISTINCT FROM m.license
                   LEFT JOIN size_fix ON size_fix.id = m.id
        ), flagged AS (
            SELECT *,
                   (coalesce(likes, 0) < 10 AND (regexp_matches({name}, '{SWEEP_RX}')
                                                 OR regexp_matches({name}, '{COURSE_RX}')
                                                 OR regexp_matches(lower(id), '{TEST_RX}')))
                   OR (coalesce(likes, 0) = 0 AND coalesce(downloads_30d, 0) < 10
                       AND created_at < {now} - INTERVAL 7 DAY) AS noise,
                   row_number() OVER (PARTITION BY author, downloads_30d
                                      ORDER BY removed, likes DESC, length(id), id) > 1
                       AND downloads_30d >= 1000 AS dl_copy
            FROM base
        )
        SELECT * EXCLUDE (dl_copy), CASE WHEN dl_copy THEN 0 ELSE downloads_30d END AS dl, dl_copy
        FROM flagged""")
    _classify_removals(con)
    stats = con.execute("""
        SELECT count(*) FILTER (WHERE noise AND NOT removed) AS noise,
               count(*) FILTER (WHERE dl_copy AND NOT removed) AS copied_downloads,
               sum(downloads_30d - dl) FILTER (WHERE NOT removed) AS copied_downloads_total,
               count(*) FILTER (WHERE parameters IS DISTINCT FROM parameters_reported) AS params_fixed,
               count(*) FILTER (WHERE license_family = 'conditional' AND NOT removed) AS conditional
        FROM m""").fetchone()
    return dict(zip(("noise", "copied_downloads", "copied_downloads_total", "params_fixed", "conditional"), stats))


def _table(con, name: str, columns: list[str], rows: list[tuple]) -> None:
    """A temp table from Python rows, via a JSON-lines file (no numpy / pandas needed)."""
    cols = [c.split()[0] for c in columns]
    con.execute(f"CREATE OR REPLACE TEMP TABLE {name} ({', '.join(columns)})")
    if not rows:
        return
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(dict(zip(cols, r))) + "\n")
    try:
        types = ", ".join(f"'{c.split()[0]}': '{c.split()[1]}'" for c in columns)
        con.execute(f"INSERT INTO {name} SELECT {', '.join(cols)} FROM read_json('{fh.name}', columns={{{types}}})")
    finally:
        os.unlink(fh.name)


def _classify_removals(con) -> None:
    stem = "regexp_replace(lower(split_part(id, '/', 2)), '[^a-z]', '', 'g')"
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE removal AS
        WITH r AS (SELECT id, author, lower(split_part(id, '/', 2)) AS name, {stem} AS stem,
                          created_at, removed_at, downloads_30d, likes FROM m WHERE removed),
             l AS (SELECT id, author, lower(split_part(id, '/', 2)) AS name, {stem} AS stem, created_at
                   FROM m WHERE NOT removed),
             succ AS (
                 SELECT r.id, max_by(l.id, l.created_at) AS successor FROM r JOIN l
                   ON l.author = r.author AND l.stem = r.stem AND length(r.stem) >= 4 AND l.id <> r.id
                  AND l.created_at >= r.created_at - INTERVAL 1 DAY
                  AND l.created_at <= coalesce(r.removed_at, r.created_at) + INTERVAL 3 DAY
                 GROUP BY r.id),
             re AS (
                 SELECT r.id, min_by(l.id, l.created_at) AS rehost FROM r JOIN l
                   ON l.name = r.name AND l.author <> r.author AND length(r.name) >= 6
                 GROUP BY r.id)
        SELECT r.id,
               CASE WHEN succ.successor IS NOT NULL THEN 'replaced'
                    WHEN re.rehost IS NOT NULL THEN 'rehosted'
                    WHEN coalesce(r.downloads_30d, 0) < 10 AND coalesce(r.likes, 0) = 0 THEN 'cleanup'
                    ELSE 'removed' END AS removal_kind,
               coalesce(succ.successor, re.rehost) AS successor
        FROM r LEFT JOIN succ USING (id) LEFT JOIN re USING (id)""")
    con.execute("""
        CREATE OR REPLACE TABLE m AS
        SELECT m.*, removal.removal_kind, removal.successor FROM m LEFT JOIN removal USING (id)""")


def copy_flag_sql(table: str = "h", part: str = "s, author, downloads_30d") -> str:
    """Same "copied download count" rule for a history table (one flag per snapshot)."""
    return (f"(row_number() OVER (PARTITION BY {part} ORDER BY removed, likes DESC, length(id), id) > 1 "
            "AND downloads_30d >= 1000)")
