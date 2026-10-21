"""Fast tests for the pipeline: run with `python -m pytest pipeline/tests`."""

from __future__ import annotations

import gzip
import json
import os

os.environ["HFO_OFFLINE"] = "1"  # tests never call the Hugging Face Hub
import sys
from pathlib import Path

import duckdb
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import build  # noqa: E402
from hfo.families import family_case_sql  # noqa: E402
from hfo.sources import MONDAY_MAJOR, Version, pick_history, snapshot_time  # noqa: E402


def model(id_, **kw):
    base = {
        "schema": 1, "id": id_, "slug": id_.replace("/", "-").lower(), "author": id_.split("/")[0],
        "url": f"https://huggingface.co/{id_}", "created_at": "2026-10-01T00:00:00.000Z",
        "updated_at": "2026-10-10T00:00:00.000Z", "license": "apache-2.0", "license_family": "oss",
        "pipeline_tag": "text-generation", "library": "transformers", "languages": ["en"], "tags": [],
        "likes": 1, "downloads_30d": 10, "trending_score": 0, "parameters": 7_000_000_000,
        "parameters_human": "7B", "storage_bytes": 14_000_000_000, "storage_human": "14 GB",
        "base_model": None, "formats": ["safetensors"], "is_conversational": True, "gated": False,
        "removed": False, "removed_at": None, "benchmarks": [], "sources": [], "ficha": "## Resumen",
    }
    base.update(kw)
    return base


FIXTURE = [
    model("Qwen/Qwen3-8B", downloads_30d=1000, likes=50),
    model("someone/my-assistant", base_model="Qwen/Qwen3-8B", tags=["base_model:finetune:Qwen/Qwen3-8B"]),
    model("quant/Qwen3-8B-GGUF", base_model="Qwen/Qwen3-8B", formats=["gguf"], library="gguf",
          tags=["base_model:quantized:Qwen/Qwen3-8B"]),
    model("gone/old-model", removed=True, removed_at="2026-10-15T00:00:00.000Z", license_family="unknown",
          license=None, gated=True),
    model("meta-llama/Llama-3.1-8B", license="llama3.1", license_family="unknown", parameters=None),
]


@pytest.fixture()
def built(tmp_path):
    gz = tmp_path / "models.jsonl.gz"
    with gzip.open(gz, "wt", encoding="utf-8") as fh:
        for m in FIXTURE:
            fh.write(json.dumps(m) + "\n")
    out = tmp_path / "data"
    build.main(["--out", str(out), "--cache", str(tmp_path / "cache"), "--latest-gz", str(gz), "--no-history"])
    return out


def test_overview_totals(built):
    ov = json.loads((built / "overview.json").read_text())
    t = ov["totals"]
    assert (t["tracked"], t["live"], t["removed"]) == (5, 4, 1)
    assert t["open_license"] == 3
    assert ov["families"][0]["family"] == "Qwen"


def test_finder_index(built):
    f = json.loads((built / "finder.json").read_text())
    assert f["count"] == 4
    ids = f["cols"]["id"]
    assert ids[0] == "Qwen/Qwen3-8B"  # sorted by downloads
    gguf = ids.index("quant/Qwen3-8B-GGUF")
    # 4-bit estimate for GGUF: 7B × 0.6 × 1.15 ≈ 4.8 GB; 16-bit otherwise ≈ 16.1 GB
    assert f["cols"]["mem"][gguf] == pytest.approx(4.8, abs=0.1)
    assert f["cols"]["mem"][0] == pytest.approx(16.1, abs=0.1)
    assert f["dict"]["format"][0] == "gguf" and f["cols"]["fmt"][gguf] & 1


def test_family_detection():
    con = duckdb.connect()
    cases = {
        ("someone/my-assistant", "Qwen/Qwen3-8B"): "Qwen",
        ("unsloth/Meta-Llama-3.1-8B-Instruct", None): "Llama",
        ("mistralai/Ministral-8B", None): "Mistral",
        ("microsoft/phi-4", None): "Phi",
        ("BAAI/bge-m3", None): "BERT-style",
        ("random/thing", None): None,
    }
    for (id_, base), expected in cases.items():
        got = con.execute(f"SELECT {family_case_sql('i', 'b')} FROM (SELECT ? AS i, ? AS b)", [id_, base]).fetchone()[0]
        assert got == expected, (id_, got)


def test_pick_history_daily_then_weekly():
    versions = [Version(d, s, p) for d in range(1, 61) for s, p in ((0, 0), (1, 0), (1, 1))]
    picked = pick_history(versions, daily_days=10, max_snapshots=100)
    majors = [v.major for v in picked]
    assert all(v.minor == 0 and v.patch == 0 for v in picked)  # first export of each day
    assert majors[-10:] == list(range(51, 61))
    assert majors[:-10] and all((m - MONDAY_MAJOR) % 7 == 0 for m in majors[:-10])
    assert len(pick_history(versions, 10, 5)) == 5


def test_graveyard(built):
    g = json.loads((built / "graveyard.json").read_text())
    assert g["totals"]["removed"] == 1
    assert g["models"]["rows"][0][0] == "gone/old-model"
    assert g["totals"]["gated_share_removed"] == 1


def test_family_trees(built):
    idx = json.loads((built / "families" / "index.json").read_text())
    top = idx["bases"][0]
    assert top["id"] == "Qwen/Qwen3-8B"
    assert top["direct"] == 2
    assert top["by_relation"]["finetune"] == 1 and top["by_relation"]["quantized"] == 1
    tree = json.loads((built / "families" / f"tree-{top['tree']}.json").read_text())
    assert {c["i"] for c in tree["tree"]["c"]} == {"someone/my-assistant", "quant/Qwen3-8B-GGUF"}


def test_snapshot_time_trusts_version_for_rebuilt_releases():
    # normal export: data timestamp on the version's day is kept
    assert snapshot_time({"major": 35, "snapshot_at": "2026-09-23T03:59:50Z"}) == "2026-09-23T03:59:50Z"
    # rebuilt release (v30 = Sep 18) stamped with the rebuild time → use the version's day
    assert snapshot_time({"major": 30, "snapshot_at": "2026-09-22T16:07:17Z"}) == "2026-09-18T04:00:00Z"


def test_trends_and_newsletter(built, tmp_path):
    from hfo import newsletter, trends
    from hfo.common import connect

    con = connect()
    con.execute(f"CREATE TABLE m AS SELECT * FROM '{(tmp_path / 'cache' / 'latest.parquet').as_posix()}'")
    # A Monday snapshot a week earlier (v54 = Oct 12) where Qwen had fewer downloads,
    # the GGUF did not exist yet and the removed model was still live.
    old = tmp_path / "v54.parquet"
    con.execute(f"""COPY (
        SELECT id, author, created_at, updated_at, pipeline_tag, license_family, likes,
               CASE WHEN id = 'Qwen/Qwen3-8B' THEN 400 ELSE downloads_30d END AS downloads_30d,
               trending_score, parameters, gated, false AS removed, NULL::TIMESTAMPTZ AS removed_at, family
        FROM m WHERE id <> 'quant/Qwen3-8B-GGUF') TO '{old.as_posix()}' (FORMAT parquet)""")
    con.execute("UPDATE m SET created_at = TIMESTAMPTZ '2026-10-17 00:00:00+00' WHERE id = 'quant/Qwen3-8B-GGUF'")
    snaps = [{"tag": "v54.0.0", "major": 54, "snapshot_at": "2026-10-12T04:00:00Z", "models": 5, "path": str(old)}]
    meta = {"snapshot_at": "2026-10-19T04:00:00Z", "models": 5, "release": "v61.0.0"}
    data, loaded = trends.build(con, snaps, meta)
    w = data["windows"]["7"]
    assert w["rising"][0]["id"] == "Qwen/Qwen3-8B" and w["rising"][0]["delta"] == 600
    assert [m["id"] for m in w["newcomers"]] == ["quant/Qwen3-8B-GGUF"]

    loaded[-1]["major"] = 61  # the latest snapshot is the Monday v61 export
    index, issues, feed = newsletter.build(con, loaded)
    issue = issues[index["issues"][0]["slug"]]
    assert issue["stats"]["created"] == 1 and issue["stats"]["removed"] == 1
    assert issue["top_new"][0]["id"] == "quant/Qwen3-8B-GGUF"
    assert "Oct 12" in issue["title"] and "quant/Qwen3-8B-GGUF" in issue["markdown"]
    assert "<rss" in feed and "<item>" in feed


def test_monday_anchor_is_a_monday():
    from hfo.sources import MONDAY_DATE, version_day

    assert MONDAY_DATE.weekday() == 0
    assert version_day(MONDAY_MAJOR) == MONDAY_DATE


def test_advisor_links_faithful_gguf(built):
    adv = json.loads((built / "advisor.json").read_text())
    ids = {m["id"]: m for m in adv["models"]}
    # the GGUF re-upload is attached to the original, not listed on its own
    assert "quant/Qwen3-8B-GGUF" not in ids
    assert ids["Qwen/Qwen3-8B"]["gguf"] == "quant/Qwen3-8B-GGUF"
    assert ids["Qwen/Qwen3-8B"]["p"] == 7.0
    # models with almost no usage are left out of recommendations
    assert "someone/my-assistant" not in ids


def test_size_from_name_when_hub_count_is_wrong():
    from hfo.advisor import size_b, TEST_REPO_RX
    assert size_b({"id": "lab/Model-35B", "parameters": 1_000_000}) == 35.0  # broken metadata
    assert size_b({"id": "lab/Qwen3-30B-A3B", "parameters": 30.5e9}) == 30.5  # "A3B" is not the size
    assert size_b({"id": "lab/Tiny-270M", "parameters": None}) == 0.27
    assert size_b({"id": "lab/no-size", "parameters": None}) is None
    assert TEST_REPO_RX.search("trl-internal-testing/tiny-Qwen2ForCausalLM-2.5")
    assert not TEST_REPO_RX.search("Qwen/Qwen3-8B")


def test_architecture_tags_drive_kv_factor_and_moe():
    from hfo.advisor import kv_factor, MOE_ARCH_RX, CANONICAL_GGUF
    assert kv_factor({"qwen3_5", "text-generation"}) == 0.25
    assert kv_factor({"deepseek_v3"}) == 0.3
    assert kv_factor({"gpt_oss"}) == 0.5
    assert kv_factor({"llama"}) is None
    assert MOE_ARCH_RX.match("glm5_next") and MOE_ARCH_RX.match("kimi_k25") and not MOE_ARCH_RX.match("qwen3")
    assert CANONICAL_GGUF["openai/gpt-oss-120b"] == "ggml-org/gpt-oss-120b-GGUF"


def test_config_summaries_of_real_architectures():
    from hfo.hfconfig import summarize
    # Llama-3.1-8B: 32 layers x 8 KV heads x 128 dims x K+V x 2 bytes = 128 KiB per token
    llama = summarize({"num_hidden_layers": 32, "num_attention_heads": 32, "num_key_value_heads": 8, "hidden_size": 4096,
                       "max_position_embeddings": 131072, "rope_scaling": {"factor": 8.0, "original_max_position_embeddings": 8192}})
    assert llama["kvb"] == 131072 and llama["mc"] == 131072 and "idle" not in llama
    # DeepSeek-V3 (MLA): (512 + 64) x 2 bytes x 61 layers; 37B of 671B active
    ds = summarize({"num_hidden_layers": 61, "num_attention_heads": 128, "num_key_value_heads": 128, "hidden_size": 7168,
                    "kv_lora_rank": 512, "qk_rope_head_dim": 64, "n_routed_experts": 256, "num_experts_per_tok": 8,
                    "moe_intermediate_size": 2048, "first_k_dense_replace": 3, "max_position_embeddings": 163840})
    assert ds["kvb"] == 576 * 2 * 61
    assert 630 < ds["idle"] < 640  # 671B - idle ~ 37B active
    # Qwen3-30B-A3B: 3.3B active of 30.5B
    q = summarize({"num_hidden_layers": 48, "num_attention_heads": 32, "num_key_value_heads": 4, "head_dim": 128, "hidden_size": 2048,
                   "num_experts": 128, "num_experts_per_tok": 8, "moe_intermediate_size": 768, "decoder_sparse_step": 1,
                   "max_position_embeddings": 40960})
    assert abs((30.5 - q["idle"]) - 3.3) < 0.2 and q["kvb"] == 48 * 2 * 4 * 128 * 2
    # gpt-oss-120b: half the layers use a 128-token sliding window
    g = summarize({"num_hidden_layers": 36, "num_attention_heads": 64, "num_key_value_heads": 8, "head_dim": 64, "hidden_size": 2880,
                   "layer_types": ["sliding_attention", "full_attention"] * 18, "sliding_window": 128,
                   "num_local_experts": 128, "experts_per_token": 4, "num_experts_per_tok": 4, "intermediate_size": 2880,
                   "max_position_embeddings": 131072})
    assert g["kvb"] == 18 * 2 * 8 * 64 * 2 and g["kvs"] == g["kvb"] and g["win"] == 128
    # Qwen3-Next / Qwen3.5 hybrid: one full-attention layer in four, nested text_config for the VL version
    n = summarize({"text_config": {"num_hidden_layers": 48, "num_attention_heads": 16, "num_key_value_heads": 2, "head_dim": 256,
                                   "hidden_size": 2048, "full_attention_interval": 4, "max_position_embeddings": 262144}})
    assert n["kvb"] == 12 * 2 * 2 * 256 * 2 and n["mc"] == 262144
    # Gemma 3 (older config): 1 global layer in 6, 1024-token window elsewhere
    gm = summarize({"num_hidden_layers": 62, "num_attention_heads": 32, "num_key_value_heads": 16, "head_dim": 128, "hidden_size": 5376,
                    "sliding_window": 1024, "sliding_window_pattern": 6, "max_position_embeddings": 131072})
    assert gm["kvb"] == 10 * 2 * 16 * 128 * 2 and gm["kvs"] == 52 * 2 * 16 * 128 * 2 and gm["win"] == 1024
    # Nemotron-H hybrid Mamba: only "*" layers attend
    nh = summarize({"num_hidden_layers": 4, "num_attention_heads": 8, "num_key_value_heads": 2, "head_dim": 128, "hidden_size": 1024,
                    "hybrid_override_pattern": "M-*-"})
    assert nh["kvb"] == 1 * 2 * 2 * 128 * 2
    assert summarize({"architectures": ["Whatever"]}) is None


def test_configs_cache_offline(tmp_path, monkeypatch):
    import json as _json
    from hfo.hfconfig import load_configs
    (tmp_path / "configs.json").write_text(_json.dumps({"a/b": {"t": 1, "kvb": 1000, "mc": 4096}, "c/d": {"t": 1, "err": 401}}))
    monkeypatch.setenv("HFO_OFFLINE", "1")
    got = load_configs(["a/b", "c/d", "e/f"], tmp_path)
    assert got == {"a/b": {"t": 1, "kvb": 1000, "mc": 4096}}


def test_published_evals_only_from_labs_and_known_benchmarks():
    import json as _json
    from hfo.advisor import published_evals
    rows = [{"dataset": "LibriSpeech (clean)", "metric": "Test WER", "value": 1.69}, {"dataset": "Common Voice 11.0", "metric": "WER", "value": 87.3},
            {"dataset": "MTEB ArguAna", "metric": None, "value": 60.1}, {"dataset": "my private set", "metric": "acc", "value": 99},
            {"dataset": "AMI (Meetings test)", "metric": "Test WER", "value": 11.2}]
    ev, mteb, wer = published_evals({"author": "nvidia", "benchmarks_json": _json.dumps(rows)})
    assert [e[0] for e in ev] == ["LibriSpeech (clean)", "AMI (Meetings test)"] and mteb == 1 and wer == 1.69
    # anyone else's claims are ignored
    assert published_evals({"author": "someone", "benchmarks_json": _json.dumps(rows)}) == ([], 0, None)
