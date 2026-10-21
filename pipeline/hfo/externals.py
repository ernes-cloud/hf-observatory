"""Outside data the advisor shows next to its estimates, fetched once per build and cached.

* API prices: OpenRouter's public model list carries each model's Hugging Face id and its price per
  token, so a card can show what the same model costs through an API.
* vLLM recipes: the vllm-project/recipes repository has tested launch guides per model family.
* Measured speeds: published llama.cpp results (the calibration points) plus results people submit
  through the "Benchmark result" issue form, once a maintainer labels them `benchmark-accepted`.

Every source is optional: without network the last cached copy is used, or the advisor goes without.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from pathlib import Path

OPENROUTER = "https://openrouter.ai/api/v1/models"
RECIPES_TREE = "https://api.github.com/repos/vllm-project/recipes/git/trees/main?recursive=1"
RECIPES_BLOB = "https://github.com/vllm-project/recipes/blob/main/"
ISSUES = "https://api.github.com/repos/{repo}/issues?labels=benchmark-accepted&state=all&per_page=100"
SITE_REPO = os.environ.get("GITHUB_REPOSITORY", "ernes-cloud/hf-observatory")

# Published measurements (llama-bench, short context): the same points tests/advisor-calibration.test.mjs uses.
CURATED = [
    {"model": "openai/gpt-oss-20b", "hw": "dgx-spark", "rt": "llamacpp", "q": "MXFP4", "tg": 80, "pp": 3600,
     "src": "https://github.com/ggml-org/llama.cpp/discussions/16578"},
    {"model": "openai/gpt-oss-120b", "hw": "dgx-spark", "rt": "llamacpp", "q": "MXFP4", "tg": 55, "pp": 1700,
     "src": "https://github.com/ggml-org/llama.cpp/discussions/16578"},
    {"model": "Qwen/Qwen3-30B-A3B", "hw": "dgx-spark", "rt": "llamacpp", "q": "Q8_0", "tg": 60, "pp": 2900,
     "src": "https://github.com/ggml-org/llama.cpp/discussions/16578"},
]


def log(msg: str) -> None:
    print(f"[externals] {msg}", flush=True)


def _get(url: str, timeout: int = 30):
    headers = {"User-Agent": "hf-observatory (+github.com/ernes-cloud/hf-observatory)", "Accept": "application/json"}
    token = os.environ.get("GITHUB_TOKEN") if "api.github.com" in url else None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as resp:
        return json.loads(resp.read(20_000_000))


def _cached(cache: Path, name: str, fetch):
    """Fresh data when the network allows, else the last good copy, else None."""
    path = cache / f"{name}.json"
    if os.environ.get("HFO_OFFLINE") != "1":
        try:
            data = fetch()
            cache.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"t": int(time.time()), "data": data}, separators=(",", ":")))
            return data
        except Exception as e:  # network or format trouble: keep going with the cache
            log(f"{name}: {type(e).__name__} {e}")
    try:
        return json.loads(path.read_text())["data"]
    except (OSError, ValueError, KeyError):
        return None


def api_prices(models: list) -> dict[str, float]:
    """Hugging Face id (lower case) → cheapest OpenRouter output price in $ per million tokens."""
    out: dict[str, float] = {}
    for m in models or []:
        hf = (m.get("hugging_face_id") or "").strip().lower()
        if not hf or str(m.get("id", "")).endswith(":free"):
            continue
        try:
            price = float((m.get("pricing") or {}).get("completion") or 0) * 1e6
        except (TypeError, ValueError):
            continue
        if price > 0 and (hf not in out or price < out[hf]):
            out[hf] = round(price, 4)
    return out


def recipe_links(tree: list, ids: list[str]) -> dict[str, str]:
    """Model id → vLLM recipe page, when a recipe file in the lab's folder names this model's family."""
    pages = [t["path"] for t in tree or [] if t.get("type") == "blob" and t.get("path", "").endswith(".md")]
    norm = lambda x: re.sub(r"[^a-z0-9]", "", x.lower())
    out = {}
    for model_id in ids:
        author, name = model_id.split("/", 1)
        best = None
        for p in pages:
            parts = p.split("/")
            if len(parts) < 2 or parts[0].lower() != author.lower():
                continue
            stem = norm(parts[-1][:-3])
            if len(stem) >= 4 and stem in norm(name) and (best is None or len(stem) > len(norm(best.split("/")[-1][:-3]))):
                best = p
        if best:
            out[model_id] = RECIPES_BLOB + best
    return out


FIELD_RX = re.compile(r"^### (.+?)\s*\n+(.+?)(?=\n### |\Z)", re.S | re.M)


def parse_benchmark_issue(issue: dict) -> dict | None:
    """One accepted "Benchmark result" issue (GitHub issue form) → a measurement, or None if incomplete."""
    fields = {k.strip().lower(): v.strip() for k, v in FIELD_RX.findall(issue.get("body") or "")}
    try:
        row = {
            "model": fields["model (hugging face id)"],
            "hw": fields["hardware id"],
            "rt": fields["runtime"].lower().replace(".", "").replace(" ", ""),
            "q": fields.get("quantization", ""),
            "tg": float(fields["generation speed (tokens/s)"]),
            "src": issue.get("html_url", ""),
        }
        pp = fields.get("prompt processing speed (tokens/s)", "")
        if re.fullmatch(r"[\d.]+", pp or ""):
            row["pp"] = float(pp)
    except (KeyError, ValueError):
        return None
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", row["model"]) or not (0 < row["tg"] < 5000):
        return None
    return row


def build(out: list[dict], cache) -> None:
    cache = Path(cache) / "snapshots"
    llm = [m for m in out if m["task"] in ("text-generation", "image-text-to-text", "any-to-any")]
    prices = api_prices(_cached(cache, "openrouter", lambda: _get(OPENROUTER)["data"]))
    tree = _cached(cache, "vllm-recipes", lambda: _get(RECIPES_TREE)["tree"])
    recipes = recipe_links(tree, [m["id"] for m in llm])
    issues = _cached(cache, "benchmarks", lambda: _get(ISSUES.format(repo=SITE_REPO)))
    measured = CURATED + [r for r in (parse_benchmark_issue(i) for i in issues or []) if r]
    by_model: dict[str, list] = {}
    for r in measured:
        by_model.setdefault(r["model"].lower(), []).append({k: v for k, v in r.items() if k != "model"})
    n_api = n_rec = n_meas = 0
    for m in llm:
        key = m["id"].lower()
        if key in prices:
            m["api"] = prices[key]
            n_api += 1
        if m["id"] in recipes:
            m["rec"] = recipes[m["id"]]
            n_rec += 1
        if key in by_model:
            m["meas"] = by_model[key]
            n_meas += 1
    log(f"API prices for {n_api}, vLLM recipes for {n_rec}, measured speeds for {n_meas} of {len(llm)} LLMs "
        f"({len(measured)} measurements, {len(measured) - len(CURATED)} from the community)")
