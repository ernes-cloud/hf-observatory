"""Fast tests for the pipeline: run with `python -m pytest pipeline/tests`."""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import duckdb
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import build  # noqa: E402
from hfo.families import family_case_sql  # noqa: E402
from hfo.sources import Version, pick_history  # noqa: E402


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
    assert all((60 - m) % 7 == 0 for m in majors[:-10])
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
