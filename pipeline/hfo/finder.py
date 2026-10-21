"""Model finder: a compact, column-oriented index of every live model.

Strings that repeat (tasks, licenses, libraries, languages, base models) are
dictionary-encoded so ~70k models fit in a few MB of JSON (well under 2 MB
gzipped, which is how GitHub Pages serves it).
"""

from __future__ import annotations

from .common import rows

FORMATS = ["gguf", "mlx", "onnx", "safetensors", "diffusers"]

# Bytes per parameter used to estimate the memory needed to load the weights.
# GGUF repos usually offer several quantizations; we assume the common 4-bit
# (Q4_K_M ≈ 4.8 bits) as the smallest practical one. ×1.15 covers runtime overhead.
# No estimate without a parameter count: repo size is unreliable (repos often
# store the same weights in several formats or precisions).
MEMORY_SQL = """
CASE
  WHEN parameters IS NULL THEN NULL
  ELSE parameters * 1.15 * CASE
    WHEN list_contains(formats, 'gguf')
      OR list_has_any(tags, ['4-bit', 'awq', 'gptq', 'nvfp4', 'mxfp4', 'exl2'])
      OR regexp_matches(lower(id), '(^|[-_.])(4bit|int4|q4|w4a16|bnb-4bit|awq|gptq|nvfp4|mxfp4)')
      THEN 0.6
    WHEN list_has_any(tags, ['8-bit', 'fp8'])
      OR regexp_matches(lower(id), '(^|[-_.])(8bit|int8|q8|fp8|w8a8)')
      THEN 1.1
    ELSE 2.0 END
END
"""


def _encode(values: list, top: list) -> tuple[list[str], list[int]]:
    index = {v: i for i, v in enumerate(top)}
    return top, [index.get(v, -1) for v in values]


def build(con) -> dict:
    data = rows(con, f"""
        SELECT id, pipeline_tag, license_family, license, library, nullif(trim(base_model), '') AS base_model, languages,
               formats, parameters, ({MEMORY_SQL}) / 1e9 AS mem_gb, downloads_30d, likes,
               trending_score, gated, is_conversational, n_benchmarks,
               CAST(epoch(created_at) / 86400 AS INTEGER) AS created_day,
               list_contains(tags, 'merge') OR list_contains(tags, 'mergekit') AS is_merge
        FROM m WHERE NOT removed
        ORDER BY downloads_30d DESC, likes DESC""")

    def dictionary(key: str, min_count: int = 1) -> list:
        counts: dict = {}
        for r in data:
            v = r[key]
            if v is not None:
                counts[v] = counts.get(v, 0) + 1
        return [k for k, c in sorted(counts.items(), key=lambda kv: -kv[1]) if c >= min_count]

    tasks, task_idx = _encode([r["pipeline_tag"] for r in data], dictionary("pipeline_tag"))
    fams = ["oss", "non-commercial", "unknown"]
    _, fam_idx = _encode([r["license_family"] for r in data], fams)
    licenses, lic_idx = _encode([r["license"] for r in data], dictionary("license"))
    libs, lib_idx = _encode([r["library"] for r in data], dictionary("library"))
    bases, base_idx = _encode([r["base_model"] for r in data], dictionary("base_model"))

    lang_counts: dict[str, int] = {}
    for r in data:
        for lang in r["languages"] or []:
            lang_counts[lang] = lang_counts.get(lang, 0) + 1
    langs = [k for k, _ in sorted(lang_counts.items(), key=lambda kv: -kv[1])]
    lang_index = {k: i for i, k in enumerate(langs)}

    def fmt_mask(fs) -> int:
        return sum(1 << FORMATS.index(f) for f in fs or [] if f in FORMATS)

    def flags(r) -> int:
        return (1 if r["gated"] else 0) | (2 if r["is_conversational"] else 0) | (4 if r["is_merge"] else 0)

    return {
        "count": len(data),
        "dict": {
            "task": tasks, "license_family": fams, "license": licenses, "library": libs,
            "base_model": bases, "language": langs, "format": FORMATS,
        },
        "flags": {"gated": 1, "conversational": 2, "merge": 4},
        "cols": {
            "id": [r["id"] for r in data],
            "task": task_idx,
            "lf": fam_idx,
            "lic": lic_idx,
            "lib": lib_idx,
            "base": base_idx,
            "lang": [[lang_index[x] for x in r["languages"] or []] for r in data],
            "fmt": [fmt_mask(r["formats"]) for r in data],
            "params": [round(r["parameters"] / 1e6, 1) if r["parameters"] else None for r in data],
            "mem": [round(r["mem_gb"], 1) if r["mem_gb"] is not None else None for r in data],
            "dl": [r["downloads_30d"] for r in data],
            "likes": [r["likes"] for r in data],
            "trend": [round(r["trending_score"], 1) if r["trending_score"] else 0 for r in data],
            "flags": [flags(r) for r in data],
            "bench": [r["n_benchmarks"] or 0 for r in data],
            "created": [r["created_day"] for r in data],
        },
    }
