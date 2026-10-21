"""Model advisor: candidates for "which model should I run on my hardware for X?".

For each candidate we keep what the in-browser recommender needs: what it is
good at (capability flags from tags, names and task), its size, license,
popularity, and which repositories let you run it with Ollama/llama.cpp (GGUF)
or on a Mac (MLX). Quantized re-uploads are not candidates themselves; they
are attached to the model they quantize as "how to run it".
"""

from __future__ import annotations

import re
from collections import defaultdict

from .common import rows

# Use cases offered by the advisor → pipeline tags that serve them.
USE_TASKS = {
    "text-generation", "image-text-to-text", "any-to-any", "feature-extraction", "sentence-similarity",
    "automatic-speech-recognition", "text-to-speech", "text-to-image", "text-ranking",
}

CAPS = ["chat", "tools", "code", "reasoning", "vision", "roleplay", "uncensored", "moe", "embed", "math",
        "computer", "swe", "sql", "longctx", "rerank"]

TAG_RULES = {
    "tools": {"tool-use", "function-calling", "tool-calling", "agent", "agentic", "tools"},
    "code": {"code", "code-generation", "coding", "coder"},
    "reasoning": {"reasoning", "thinking", "chain-of-thought", "cot"},
    "vision": {"vision", "multimodal", "vision-language", "vision-language-model", "image-text-to-text"},
    "roleplay": {"roleplay", "roleplaying", "creative-writing", "storytelling", "rp"},
    "uncensored": {"uncensored", "abliterated", "abliteration", "heretic"},
    "moe": {"moe", "mixture-of-experts"},
    "math": {"math", "mathematics"},
    "computer": {"computer-use", "gui-agent", "gui", "gui-grounding", "browser", "browser-agent", "web-agent",
                 "browser-use", "os-agent", "ui-tars", "screen-agent"},
    "swe": {"swe-bench", "swe", "software-engineering", "coding-agent", "agentic-coding"},
    "sql": {"text-to-sql", "sql", "sqlite", "nl2sql"},
    "longctx": {"long-context", "1m-context", "1m context", "128k", "256k", "long-context-understanding"},
    "rerank": {"reranker", "reranking", "rerank"},
}
NAME_RULES = {
    "code": r"coder|code|codestral|devstral|starcoder|swe-|deepseek-coder",
    "reasoning": r"(^|[-_/.])(r1|qwq|reason|reasoning|thinking|think)([-_/.]|$)",
    "uncensored": r"uncensored|abliterat|heretic|obliterat",
    "tools": r"(^|[-_/.])(agent|agentic|tool|fc|function)",
    "roleplay": r"roleplay|(^|[-_/.])rp([-_/.]|$)|storyteller",
    "chat": r"instruct|chat|(^|[-_/.])it([-_/.]|$)",
    "computer": r"ui-tars|computer-use|gui-|webagent|web-agent|browser|os-atlas|showui|opencua",
    "swe": r"devstral|swe-|openhands|swe_|qwen3-coder",
    "sql": r"sql",
    "longctx": r"(^|[-_/.])(128k|256k|512k|1m|1048k)([-_/.]|$)",
    "rerank": r"rerank",
}
# Families whose recent instruct models are trained for tool calling even when untagged.
TOOL_FAMILIES = {"Qwen", "Llama", "Mistral", "GLM", "GPT-OSS", "Kimi", "MiniMax", "Granite", "Nemotron", "DeepSeek", "Gemma"}

# Well-known publishers of faithful quantizations (preferred when several exist).
TRUSTED_QUANTIZERS = {
    "bartowski", "unsloth", "lmstudio-community", "ggml-org", "mradermacher", "mlx-community",
    "thebloke", "quantfactory", "second-state", "gaianet", "nousresearch",
}

# Name tokens a faithful re-upload may add to the original name.
QUANT_TOKEN = re.compile(
    r"gguf|mlx|awq|gptq|exl2|imatrix|i\d|imat|quant|quants|quantized|meta|hf|bf16|fp16|f16|fp8|int8|int4|nvfp4|mxfp4"
    r"|q\d.*|iq\d.*|\d+bit|\d+-bit|w\d+a\d+|dwq|dynamic|ud|k|m|s|l|xl|xs|xxs|0|1"
)

ACTIVE_RX = re.compile(r"[-_.]a(\d+(?:\.\d+)?)b(?:[-_.]|$)", re.I)

# Active parameters (billions) of well-known mixture-of-experts models whose names do not say it.
KNOWN_ACTIVE = [
    (r"gpt-oss-120b", 5.1), (r"gpt-oss-20b", 3.6),
    (r"deepseek-(v3|r1)(?![-.]?distill)", 37), (r"kimi-k2", 32),
    (r"glm-4\.[5-9]-air", 12), (r"glm-4\.[5-9](?!-air|v|-flash)", 32),
    (r"mixtral-8x7b", 12.9), (r"mixtral-8x22b", 39), (r"llama-4-(scout|maverick)", 17),
    (r"minimax-m2", 10), (r"qwen3-(coder-)?next", 3), (r"ernie-4\.5-21b", 3),
]


def build(con) -> dict:
    models = rows(con, f"""
        SELECT id, author, pipeline_tag AS task, license_family AS lf, license, parameters, family,
               languages, tags, formats, library, downloads_30d AS dl, likes, trending_score AS trend,
               is_conversational AS chat, gated, CAST(epoch(created_at) / 86400 AS INTEGER) AS created_day,
               nullif(trim(base_model), '') AS base_model
        FROM m WHERE NOT removed AND pipeline_tag IN ({", ".join(f"'{t}'" for t in sorted(USE_TASKS))})""")

    by_id = {m["id"].lower(): m for m in models}

    # parent → quantized children, per format (from Hub relation tags, falling back to base_model)
    gguf_kids: dict[str, list[dict]] = defaultdict(list)
    mlx_kids: dict[str, list[dict]] = defaultdict(list)
    quantized_of: dict[str, str] = {}
    for m in models:
        parents = [t.split(":", 2)[2].lower() for t in m["tags"] or [] if t.startswith("base_model:quantized:")]
        if not parents and m["base_model"] and ("gguf" in (m["formats"] or []) or "mlx" in (m["formats"] or [])):
            parents = [p.strip().lower() for p in m["base_model"].split(",")][:1]
        for p in parents[:1]:
            quantized_of[m["id"].lower()] = p
            if "gguf" in (m["formats"] or []):
                gguf_kids[p].append(m)
            if "mlx" in (m["formats"] or []):
                mlx_kids[p].append(m)

    def norm(s: str) -> str:
        return re.sub(r"[^a-z0-9]", "", s.lower())

    def best(parent_id: str, kids: list[dict]) -> str | None:
        """The most trusted faithful re-upload: its name must contain the original's name,
        and uncensored/abliterated rewrites are skipped unless the original is one."""
        base_name = parent_id.split("/")[-1].lower()
        parent_author = parent_id.split("/")[0].lower()

        def faithful(k) -> bool:
            # e.g. "Qwen3-8B-GGUF", "Meta-Llama-3.1-8B-Instruct-Q4_K_M-GGUF", "Qwen3-8B-mlx-4bit"
            name = k["id"].split("/")[-1].lower()
            i = name.find(base_name)
            if i < 0:
                return False
            extra = [t for t in re.split(r"[-_.\s]+", name[:i] + " " + name[i + len(base_name):]) if t]
            return all(QUANT_TOKEN.fullmatch(t) for t in extra)

        ok = [k for k in kids if faithful(k)]
        if not ok:
            return None

        def rank(k):
            author = k["author"].lower()
            return (author == parent_author, author in TRUSTED_QUANTIZERS, k["dl"] or 0, k["likes"] or 0)
        return max(ok, key=rank)["id"]

    def caps_of(m: dict) -> int:
        tags = {t.lower() for t in m["tags"] or []}
        name = m["id"].lower()
        caps = set()
        for cap, rule in TAG_RULES.items():
            if tags & rule:
                caps.add(cap)
        for cap, rx in NAME_RULES.items():
            if re.search(rx, name):
                caps.add(cap)
        if m["chat"]:
            caps.add("chat")
        if m["task"] in ("image-text-to-text", "any-to-any"):
            caps.add("vision")
        if m["task"] in ("feature-extraction", "sentence-similarity"):
            caps.add("embed")
        if m["task"] == "text-ranking":
            caps.add("rerank")
        if ACTIVE_RX.search(name) or any("moe" in t for t in tags):
            caps.add("moe")
        return sum(1 << CAPS.index(c) for c in caps)

    out = []
    for m in models:
        key = m["id"].lower()
        if m["library"] == "peft" or any(t.startswith("base_model:adapter:") for t in m["tags"] or []):
            continue  # adapters need their base model; not standalone recommendations
        parent = quantized_of.get(key)
        if parent and parent in by_id:
            continue  # a re-upload of a model we already list; it becomes that model's run link
        fmts = m["formats"] or []
        gguf = m["id"] if "gguf" in fmts else best(m["id"], gguf_kids.get(key, []))
        mlx = m["id"] if "mlx" in fmts else best(m["id"], mlx_kids.get(key, []))
        popular = (m["dl"] or 0) >= 300 or (m["likes"] or 0) >= 25 or (m["trend"] or 0) > 0
        if not popular:
            continue
        active = ACTIVE_RX.search(m["id"])
        active_b = float(active.group(1)) if active else None
        if active_b is None:
            for rx, a in KNOWN_ACTIVE:
                # sanity check: a distilled dense model (e.g. "DeepSeek-R1-…-Qwen3-8B") is not the MoE original
                if re.search(rx, m["id"].lower()) and (m["parameters"] or 0) / 1e9 > a * 2:
                    active_b = a
                    break
        out.append({
            "id": m["id"],
            "task": m["task"],
            "p": round(m["parameters"] / 1e9, 2) if m["parameters"] else None,
            "a": active_b,
            "fam": m["family"],
            "lf": m["lf"],
            "lic": m["license"],
            "lang": (m["languages"] or [])[:12],
            "dl": m["dl"] or 0,
            "likes": m["likes"] or 0,
            "tr": round(m["trend"] or 0, 1),
            "c": m["created_day"],
            "caps": caps_of(m),
            "gated": bool(m["gated"]),
            "st": "safetensors" in fmts,
            "gguf": gguf,
            "mlx": mlx,
            # for re-uploads whose original is not tracked: show what they quantize
            "of": parent if parent else None,
        })

    out.sort(key=lambda r: -r["dl"])
    return {"caps": CAPS, "tool_families": sorted(TOOL_FAMILIES), "models": out}
