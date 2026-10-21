"""Model architecture from each repository's ``config.json`` on the Hugging Face Hub.

The advisor needs a few numbers the dataset does not carry: how many bytes of KV cache a token costs
(layers, KV heads, head size, MLA, sliding-window and linear-attention layers), the longest context
the model was built for, and, for mixture-of-experts models, how many parameters work per token.

Configs are fetched once and cached in ``CACHE/configs.json`` (failures are retried after a week),
so a daily run only downloads the configs of new models. Without network access the cache (or
nothing) is used and the advisor falls back to its size-based estimates.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

URL = "https://huggingface.co/{id}/resolve/main/config.json"
RETRY_AFTER = 7 * 86400
NESTED = ("text_config", "llm_config", "language_config", "thinker_config")


def log(msg: str) -> None:
    print(f"[hfconfig] {msg}", flush=True)


def _text_config(cfg: dict) -> dict:
    """Vision-language and omni models keep the language model's settings in a nested block."""
    for key in NESTED:
        sub = cfg.get(key)
        if isinstance(sub, dict):
            if key == "thinker_config" and isinstance(sub.get("text_config"), dict):
                sub = sub["text_config"]
            if sub.get("num_hidden_layers"):
                return {**cfg, **sub}
    return cfg


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None


def summarize(cfg: dict) -> dict | None:
    """Reduce a config.json to what the advisor uses. Returns None if it is not a decoder we understand.

    kvb: KV-cache bytes per token at 16-bit in the layers that attend over the whole context
    kvs: KV-cache bytes per token in sliding-window layers, which never hold more than `win` tokens
    win: sliding-window size; mc: longest context; act: active parameters (billions) for MoE models
    """
    c = _text_config(cfg)
    layers = _num(c.get("num_hidden_layers") or c.get("n_layer") or c.get("num_layers"))
    heads = _num(c.get("num_attention_heads") or c.get("n_head"))
    hidden = _num(c.get("hidden_size") or c.get("d_model") or c.get("n_embd"))
    if not layers:
        return None
    layers = int(layers)
    out: dict = {}

    # Which layers keep a KV cache, and for how many tokens.
    full, sliding = layers, 0
    types = c.get("layer_types")
    if isinstance(types, list) and types:
        t = [str(x).lower() for x in types]
        full = sum(1 for x in t if x in ("full_attention", "attention", "global_attention", "full"))
        sliding = sum(1 for x in t if "sliding" in x or x in ("local_attention", "chunked_attention"))
    elif isinstance(c.get("hybrid_override_pattern"), str):  # Nemotron-H: "*" = attention, "M" = Mamba
        full = c["hybrid_override_pattern"].count("*")
    elif _num(c.get("full_attention_interval")):  # Qwen3-Next style: one full layer every N
        full = layers // int(c["full_attention_interval"])
    elif _num(c.get("attn_layer_period")):  # Jamba
        full = layers // int(c["attn_layer_period"])
    elif _num(c.get("sliding_window_pattern")) and _num(c.get("sliding_window")):  # Gemma 3: 1 global per N
        n = int(c["sliding_window_pattern"])
        full = layers // n
        sliding = layers - full
    elif str(c.get("model_type", "")).startswith("mamba"):
        full = 0
    win = _num(c.get("sliding_window")) if sliding else None
    if sliding and not win:  # sliding layers without a window size: count them as full
        full, sliding = full + sliding, 0

    # Bytes per token per layer.
    if _num(c.get("kv_lora_rank")):  # MLA (DeepSeek-V3, Kimi K2, GLM-5): one compressed latent per token
        per_layer = (c["kv_lora_rank"] + (c.get("qk_rope_head_dim") or 64)) * 2
    else:
        kv_heads = _num(c.get("num_key_value_heads") or c.get("num_kv_heads") or c.get("multi_query_group_num")) or heads
        head_dim = _num(c.get("head_dim")) or (hidden / heads if hidden and heads else None)
        if not kv_heads or not head_dim:
            return None
        per_layer = 2 * kv_heads * head_dim * 2  # keys and values, 2 bytes each
    out["kvb"] = round(full * per_layer)
    if sliding:
        out["kvs"] = round(sliding * per_layer)
        out["win"] = int(win)

    # Longest context: position embeddings, times a static RoPE scaling factor when the config enables one.
    mc = _num(c.get("max_position_embeddings") or c.get("max_sequence_length") or c.get("seq_length") or c.get("n_positions"))
    rs = c.get("rope_scaling") or {}
    if isinstance(rs, dict) and _num(rs.get("factor")) and _num(rs.get("original_max_position_embeddings")):
        mc = max(mc or 0, rs["factor"] * rs["original_max_position_embeddings"])
    if mc and 512 <= mc <= 16_777_216:
        out["mc"] = int(mc)

    # Active parameters of a mixture of experts: total minus the experts that sit idle for each token.
    experts = _num(c.get("num_experts") or c.get("n_routed_experts") or c.get("num_local_experts") or c.get("moe_num_experts"))
    topk = _num(c.get("num_experts_per_tok") or c.get("num_experts_per_token") or c.get("moe_k") or c.get("top_k"))
    inter = _num(c.get("moe_intermediate_size") or c.get("expert_intermediate_size")) or (
        _num(c.get("intermediate_size")) if c.get("num_local_experts") else None)
    if experts and topk and inter and hidden and experts > topk:
        dense_first = int(c.get("first_k_dense_replace") or 0)
        step = int(c.get("decoder_sparse_step") or 1) or 1
        moe_layers = len([i for i in range(dense_first, layers) if (i + 1) % step == 0])
        out["idle"] = round((experts - topk) * 3 * hidden * inter * moe_layers / 1e9, 3)  # idle expert weights (B)
    return out


def _fetch(model_id: str, token: str | None) -> tuple[str, dict]:
    req = urllib.request.Request(URL.format(id=model_id), headers={"User-Agent": "hf-observatory (+github.com/ernes-cloud/hf-observatory)"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            cfg = json.loads(resp.read(2_000_000))
        s = summarize(cfg) if isinstance(cfg, dict) else None
        return model_id, {"t": int(time.time()), **(s or {"none": 1})}
    except urllib.error.HTTPError as e:
        return model_id, {"t": int(time.time()), "err": e.code}
    except Exception as e:  # network trouble: try again next run
        return model_id, {"t": int(time.time()) - RETRY_AFTER, "err": type(e).__name__}


def load_configs(ids: list[str], cache: Path, max_new: int | None = None, workers: int = 16) -> dict[str, dict]:
    """Summaries for `ids` (most important first), fetching up to `max_new` missing ones."""
    path = cache / "configs.json"
    try:
        known = json.loads(path.read_text()) if path.exists() else {}
    except (OSError, ValueError):
        known = {}
    now = time.time()
    todo = [i for i in ids if i not in known or ("err" in known[i] and now - known[i].get("t", 0) > RETRY_AFTER)]
    limit = int(os.environ.get("HFO_CONFIG_FETCH", max_new if max_new is not None else 2500))
    todo = todo[:limit]
    if todo and os.environ.get("HFO_OFFLINE") != "1":
        token = os.environ.get("HF_TOKEN") or None
        start = time.time()
        with ThreadPoolExecutor(workers) as pool:
            for model_id, res in pool.map(lambda i: _fetch(i, token), todo):
                known[model_id] = res
        got = sum(1 for i in todo if "kvb" in known[i])
        errs = sum(1 for i in todo if "err" in known[i])
        log(f"fetched {len(todo)} configs in {time.time() - start:.0f}s: {got} usable, {errs} errors (gated / missing / network)")
        try:
            cache.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(known, separators=(",", ":")))
        except OSError as e:
            log(f"could not save the cache: {e}")
    usable = {i: known[i] for i in ids if i in known and "kvb" in known[i]}
    log(f"{len(usable)} of {len(ids)} advisor models have an architecture summary")
    return usable
