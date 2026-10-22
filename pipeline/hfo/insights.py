"""Insights: questions about the ecosystem that no single list answers.

* **Quantizers**: who turns new models into GGUF / MLX / NVFP4 builds, how many, in which formats,
  and how fast after the base model appeared (only for bases created after tracking began, so the
  creation dates of both sides are known).
* **Fastest after new releases**: for recent base models with several quantizations, who shipped
  the first build of each format and how long it took.
* **Copies and look-alikes**: repository names that live under many accounts. When one of them is
  an original lab, the others are copies of an official release (mirrors, re-uploads or worse).
* **Model-card completeness**: for the most downloaded publishers, how often their cards declare a
  task, a license, languages, a base model (for derived models) and results.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from statistics import median

from .common import rows

LABS = {
    "qwen", "meta-llama", "mistralai", "google", "microsoft", "deepseek-ai", "openai", "nvidia", "zai-org", "ibm-granite",
    "huggingfacetb", "allenai", "liquidai", "moonshotai", "minimaxai", "tencent", "baidu", "coherelabs", "stepfun-ai",
    "xiaomimimo", "openbmb", "inclusionai", "baai", "intfloat", "nomic-ai", "jinaai", "mixedbread-ai", "alibaba-nlp",
    "sentence-transformers", "kyutai", "hexgrad", "canopylabs", "resemble-ai", "apple", "black-forest-labs", "stabilityai",
    "lightricks", "fishaudio", "black-forest-labs", "meta-models", "openmoss-team", "thinkingmachines",
}
QUANT_FORMATS = (("GGUF", "gguf"), ("MLX", "mlx"))
QUANTIZERS = 15
RELEASES = 12
COPIES = 20
PUBLISHERS = 30
GENERIC_NAMES = {"model", "test", "lora", "adapter", "checkpoint", "output", "outputs", "results", "my-model", "final"}


def _fmt_of(m: dict) -> str:
    name = m["id"].lower()
    fmts = m["formats"] or []
    if "gguf" in fmts or "gguf" in name:
        return "GGUF"
    if "mlx" in fmts or "mlx" in name:
        return "MLX"
    if "nvfp4" in name or "mxfp4" in name:
        return "NVFP4 / MXFP4"
    if "awq" in name or "gptq" in name or "autoround" in name:
        return "AWQ / GPTQ"
    if "fp8" in name:
        return "FP8"
    return "Other"


def build(con, tracking_start: str) -> dict:
    models = rows(con, """
        SELECT id, author, lower(id) AS k, epoch(created_at) AS created_at, formats, tags, downloads_30d AS dl, likes, noise, removed,
               pipeline_tag AS task, license, languages, nullif(trim(base_model), '') AS base_model, n_benchmarks
        FROM m""")
    by_id = {m["k"]: m for m in models}
    start = datetime.fromisoformat(tracking_start).replace(tzinfo=timezone.utc).timestamp()

    # ---- quantizations: child → parent edges declared with base_model:quantized:<parent>
    quants = []
    for m in models:
        if m["removed"]:
            continue
        for tag in m["tags"] or []:
            if tag.startswith("base_model:quantized:"):
                parent = by_id.get(tag.split(":", 2)[2].strip().lower())
                quants.append((m, parent))
                break
    per_author: dict[str, dict] = defaultdict(lambda: {"n": 0, "dl": 0, "formats": defaultdict(int), "lags": []})
    for m, parent in quants:
        a = per_author[m["author"]]
        a["n"] += 1
        a["dl"] += m["dl"] or 0
        a["formats"][_fmt_of(m)] += 1
        if parent and parent["created_at"] and m["created_at"] and parent["created_at"] >= start:
            lag = (m["created_at"] - parent["created_at"]) / 3600
            if lag >= 0:
                a["lags"].append(lag)
    quantizers = sorted(per_author.items(), key=lambda kv: -kv[1]["n"])[:QUANTIZERS]
    formats_total: dict[str, int] = defaultdict(int)
    for m, _ in quants:
        formats_total[_fmt_of(m)] += 1

    # ---- the first builds after recent base releases
    kids_of: dict[str, list] = defaultdict(list)
    for m, parent in quants:
        if parent:
            kids_of[parent["k"]].append(m)
    releases = []
    for k, kids in kids_of.items():
        base = by_id[k]
        if (len(kids) < 3 or not base["created_at"] or base["created_at"] < start or base["removed"]
                or _fmt_of(base) != "Other" or any(t.startswith("base_model:quantized:") for t in base["tags"] or [])):
            continue  # only original releases, not quantizations of quantizations
        firsts = {}
        for kid in sorted(kids, key=lambda x: x["created_at"] or 0):
            f = _fmt_of(kid)
            if f not in firsts and (kid["created_at"] or 0) >= base["created_at"]:
                firsts[f] = {"id": kid["id"], "hours": round((kid["created_at"] - base["created_at"]) / 3600, 1)}
        day = datetime.fromtimestamp(base["created_at"], timezone.utc).strftime("%Y-%m-%d")
        releases.append({"base": base["id"], "dl": base["dl"], "created": day,
                         "quantizations": len(kids), "firsts": firsts})
    releases.sort(key=lambda r: -(r["dl"] or 0))

    # ---- copies: one repo name under many accounts
    by_name: dict[str, list] = defaultdict(list)
    for m in models:
        if m["removed"]:
            continue
        name = m["k"].split("/", 1)[1]
        if len(name) >= 6 and name not in GENERIC_NAMES:
            by_name[name].append(m)
    copies = []
    for name, ms in by_name.items():
        if len(ms) < 3:
            continue
        official = [m for m in ms if m["author"].lower() in LABS]
        ms.sort(key=lambda m: -(m["dl"] or 0))
        lead = official[0] if official else ms[0]
        others = [m for m in ms if m is not lead]
        copies.append({
            "name": lead["id"].split("/", 1)[1], "official": lead["id"] if official else None, "lead": lead["id"],
            "lead_dl": lead["dl"], "copies": len(others), "copies_dl": sum(m["dl"] or 0 for m in others),
            "top_copies": [[m["id"], m["dl"]] for m in others[:4]],
            "copy_outranks": bool(official) and any((m["dl"] or 0) > (lead["dl"] or 0) for m in others),
        })
    copies.sort(key=lambda c: (c["official"] is None, -c["copies"], -(c["copies_dl"] or 0)))

    # ---- model-card completeness for the most downloaded publishers
    pubs: dict[str, list] = defaultdict(list)
    for m in models:
        if not m["removed"] and not m["noise"]:
            pubs[m["author"]].append(m)
    top_pubs = sorted(pubs.items(), key=lambda kv: -sum(m["dl"] or 0 for m in kv[1]))[:PUBLISHERS]
    cards = []
    for author, ms in top_pubs:
        n = len(ms)
        derived = [m for m in ms if m["base_model"]]
        share = lambda pred, xs=ms: round(sum(1 for m in xs if pred(m)) / len(xs), 3) if xs else None  # noqa: E731
        row = {
            "author": author, "models": n,
            "task": share(lambda m: m["task"]),
            "license": share(lambda m: m["license"] and m["license"] not in ("other", "unknown")),
            "languages": share(lambda m: m["languages"]),
            "results": share(lambda m: (m["n_benchmarks"] or 0) > 0),
            "derived": len(derived),
            "base": share(lambda m: m["base_model"], derived) if derived else None,
        }
        parts = [v for k, v in row.items() if k in ("task", "license", "languages", "results") and v is not None]
        row["score"] = round(sum(parts) / len(parts), 3) if parts else None
        cards.append(row)

    return {
        "quantizations": len(quants),
        "formats": [{"format": f, "models": n} for f, n in sorted(formats_total.items(), key=lambda kv: -kv[1])],
        "quantizers": [{
            "author": a, "models": v["n"], "downloads": v["dl"],
            "formats": dict(sorted(v["formats"].items(), key=lambda kv: -kv[1])),
            "median_hours": round(median(v["lags"]), 1) if v["lags"] else None, "timed": len(v["lags"]),
        } for a, v in quantizers],
        "releases": releases[:RELEASES],
        "copies": copies[:COPIES],
        "copies_total": len(copies),
        "copies_official": sum(1 for c in copies if c["official"]),
        "cards": cards,
        "tracking_start": tracking_start,
    }
