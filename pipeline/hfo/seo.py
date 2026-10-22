"""Static pages for search engines and link previews.

The site is a single page whose sections live after a ``#``, which crawlers ignore. The pipeline
therefore also writes plain HTML pages under ``web/p/`` (no JavaScript needed to read them): one
per section, one per model among the most downloaded, one per family tree and one per newsletter
issue. Each has its own title, description, canonical URL and Open Graph tags, and links to the
interactive page. ``sitemap.xml`` lists them all and ``robots.txt`` points to it.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

from .newsletter import SITE_URL, compact, params, task

MODEL_PAGES = 2000
OG_IMAGE = "og.png"
LICENSE_TEXT = {
    "oss": "open-source license (commercial use allowed)",
    "conditional": "custom license: commercial use usually allowed with conditions",
    "non-commercial": "non-commercial license",
    "unknown": "license not declared",
}
REL_ONE = {"finetune": "fine-tune", "quantized": "quantization", "adapter": "adapter", "merge": "merge", "derivative": "derivative"}


def esc(x) -> str:
    return html.escape("" if x is None else str(x), quote=True)


def slug(model_id: str) -> str:
    return "/".join(re.sub(r"[^A-Za-z0-9._-]", "-", part) for part in model_id.split("/"))


def page(path: str, title: str, description: str, body: str, interactive: str, ld: dict | None = None) -> str:
    """One static page. ``path`` is relative to the site root, e.g. "p/finder/"."""
    depth = path.strip("/").count("/") + 1
    rel = "../" * depth
    url = SITE_URL + path
    ld_html = f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>' if ld else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)} · HF Observatory</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="HF Observatory">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{esc(url)}">
<meta property="og:image" content="{esc(SITE_URL + OG_IMAGE)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{rel}favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{rel}css/style.css">
{ld_html}
</head>
<body>
<header class="site-header"><div class="wrap header-row"><a class="brand" href="{rel}"><span class="brand-text"><span class="brand-name">HF Observatory</span><span class="brand-tag">The Hugging Face model ecosystem, explained</span></span></a></div></header>
<main class="wrap static-page">
<article class="prose">
<h1>{esc(title)}</h1>
<p class="lead">{esc(description)}</p>
<p><a class="btn btn-primary" href="{rel}{interactive}">Open the interactive page →</a></p>
{body}
</article>
</main>
<footer class="site-footer"><div class="wrap"><p>Data: <a href="https://github.com/686f6c61/radar-huggingface-dataset">radar-huggingface-dataset</a>
by HF//RADAR (CC-BY-4.0); model metadata from the <a href="https://huggingface.co">Hugging Face Hub</a>. Not affiliated with Hugging Face.</p></div></footer>
</body>
</html>
"""


def model_list(ids, pages: set[str], rel: str, extra=lambda m: "") -> str:
    out = []
    for m in ids:
        mid = m["id"] if isinstance(m, dict) else m
        href = f"{rel}p/models/{slug(mid)}/" if mid.lower() in pages else f"{rel}#model?id={mid}"
        out.append(f'<li><a href="{esc(href)}">{esc(mid)}</a>{extra(m) if isinstance(m, dict) else ""}</li>')
    return "<ul>" + "".join(out) + "</ul>"


def md_to_html(md: str) -> str:
    """The newsletter's Markdown subset: headings, lists, links, bold, paragraphs."""
    def inline(t: str) -> str:
        t = esc(t)
        t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>', t)
        return re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
    out, mode = [], None
    for line in md.splitlines():
        kind = "ul" if line.startswith("- ") else "ol" if re.match(r"\d+\. ", line) else None
        if mode and kind != mode:
            out.append(f"</{mode}>")
            mode = None
        if line.startswith("#"):
            level = min(len(line) - len(line.lstrip("#")) + 1, 4)
            if level > 2:
                out.append(f"<h{level}>{inline(line.lstrip('#').strip())}</h{level}>")
        elif kind:
            if not mode:
                out.append(f"<{kind}>")
                mode = kind
            item = re.sub(r"^(- |\d+\. )", "", line)
            out.append(f"<li>{inline(item)}</li>")
        elif line.strip() and line.strip() != "---":
            out.append(f"<p>{inline(line)}</p>")
    if mode:
        out.append(f"</{mode}>")
    return "\n".join(out)


def describe(r: dict) -> str:
    bits = [b for b in (params(r.get("p")), task(r["t"]) if r.get("t") else "") if b]
    s = f"{' '.join(bits) or 'Model'} published by {r['id'].split('/')[0]} on Hugging Face"
    if r.get("par"):
        s += f", a {REL_ONE.get(r['par'][0][1], 'derivative')} of {r['par'][0][0]}"
    s += f". {compact(r.get('dl'))} downloads in the last 30 days, {r.get('lk') or 0} likes; {LICENSE_TEXT.get(r.get('lf'), 'license not declared')}."
    return s[0].upper() + s[1:]


def build(site: Path, data: dict) -> int:
    """Write web/p/…, sitemap.xml and robots.txt. ``data`` holds the built JSON payloads."""
    root = site / "p"
    if root.exists():
        for f in sorted(root.rglob("*"), reverse=True):
            f.unlink() if f.is_file() else f.rmdir()
    written: list[str] = []

    def write(path: str, text: str) -> None:
        f = site / path / "index.html"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")
        written.append(path)

    shards, ov, tr, gy, fam, issues = (data[k] for k in ("shards", "overview", "trends", "graveyard", "families", "issues"))
    records = [r for recs in shards.values() for r in recs.values()]
    top = sorted((r for r in records if not r.get("rm") and "noise" not in (r.get("fl") or [])), key=lambda r: -(r.get("dl") or 0))[:MODEL_PAGES]
    pages = {r["id"].lower() for r in top}
    t = ov["totals"]

    # ---- models
    for r in top:
        path = f"p/models/{slug(r['id'])}/"
        rel = "../" * (path.strip("/").count("/") + 1)
        facts = [("Publisher", r["id"].split("/")[0]), ("Task", task(r["t"]) if r.get("t") else "–"),
                 ("Size", params(r.get("p")) or "–"), ("License", r.get("lic") or "not declared"),
                 ("Formats", ", ".join(r.get("fmt") or []) or "–"), ("Downloads (30 days)", f"{r.get('dl') or 0:,}"),
                 ("Likes", f"{r.get('lk') or 0:,}"), ("Created", r.get("c") or "–"), ("Family", r.get("fam") or "–")]
        body = "<h2>Details</h2><dl class=\"facts\">" + "".join(f"<dt>{esc(k)}</dt><dd>{esc(v)}</dd>" for k, v in facts) + "</dl>"
        if r.get("par"):
            body += "<h2>Built on</h2>" + model_list([p for p, _ in r["par"]], pages, rel)
        if r.get("top"):
            n = sum((r.get("kids") or {}).values())
            body += f"<h2>{n:,} models built on it</h2>" + model_list([c for c, _, _ in r["top"]], pages, rel)
        if r.get("bm"):
            body += "<h2>Results reported on its model card</h2><ul>" + "".join(
                f"<li>{esc(b[1])}: {esc(b[2])} = {esc(b[3])}</li>" for b in r["bm"][:8]) + "</ul>"
        body += f'<p><a href="https://huggingface.co/{esc(r["id"])}">{esc(r["id"])} on Hugging Face</a></p>'
        write(path, page(path, r["id"], describe(r), body, f"#model?id={r['id']}",
                         {"@context": "https://schema.org", "@type": "SoftwareSourceCode", "name": r["id"],
                          "url": f"https://huggingface.co/{r['id']}", "author": r["id"].split("/")[0]}))

    # ---- sections
    rel = "../../"
    finder_body = f"<h2>Most downloaded models</h2>" + model_list(top[:100], pages, rel, lambda m: f" — {compact(m.get('dl'))} downloads")
    write("p/finder/", page("p/finder/", "Find an AI model on Hugging Face",
                            f"Search {t['live']:,} live open models by task, language, license, memory and format.", finder_body, "#finder"))
    ov_body = ("<h2>Top publishers by downloads</h2><ul>" + "".join(
        f"<li>{esc(o['author'])}: {compact(o['downloads'])} downloads</li>" for o in ov["top_orgs_by_downloads"]) + "</ul>"
        + "<h2>Families</h2><ul>" + "".join(f"<li>{esc(f['family'])}: {f['models']:,} models, {compact(f['downloads'])} downloads</li>" for f in ov["families"][:20]) + "</ul>")
    write("p/overview/", page("p/overview/", "The Hugging Face model ecosystem at a glance",
                              f"{t['live']:,} live models from {t['authors']:,} publishers: who publishes, which tasks, sizes, formats and licenses.", ov_body, "#overview"))
    w = (tr.get("windows") or {}).get("7") or {}
    tr_body = "<h2>Rising this week</h2>" + model_list(w.get("rising", [])[:20], pages, rel, lambda m: f" (+{compact(m.get('delta'))})") \
        + "<h2>New on the Hub</h2>" + model_list(w.get("newcomers", [])[:20], pages, rel, lambda m: f" — {compact(m.get('new'))} downloads")
    write("p/trends/", page("p/trends/", "Which AI models are rising and fading", "Download trends for open models on Hugging Face over 7, 14 and 30 days.", tr_body, "#trends"))
    gy_body = "<h2>Notable removals</h2><ul>" + "".join(f"<li>{esc(m['id'])}: {compact(m['downloads'])} downloads before removal, removed {esc(m['removed_at'])}</li>" for m in gy["notable"]) + "</ul>"
    write("p/graveyard/", page("p/graveyard/", "Models deleted from Hugging Face",
                               f"{gy['totals']['removed']:,} models disappeared from the Hub: who removes them, how long they lived, and what replaced them.", gy_body, "#graveyard"))
    write("p/advisor/", page("p/advisor/", "Which open model should I run on my GPU or Mac?",
                             "Pick the job and your hardware (NVIDIA, AMD, Apple Silicon, DGX Spark…) and get the models that fit, estimated speed and ready-to-run commands for Ollama, llama.cpp, LM Studio, MLX, vLLM and SGLang.",
                             "<p>The advisor ranks open models from Hugging Face for chat, coding, agents, reasoning, vision, RAG, speech and image generation, and writes Docker Compose files for them.</p>", "#advisor"))

    # ---- family trees
    fam_links = []
    for b in fam["bases"]:
        if b.get("tree") is None:
            continue
        path = f"p/families/{slug(b['id'])}/"
        r2 = "../" * (path.strip("/").count("/") + 1)
        body = "<h2>Derivatives by kind</h2><ul>" + "".join(f"<li>{esc(REL_ONE.get(k, k))}: {v:,}</li>" for k, v in b["by_relation"].items() if v) + "</ul>"
        write(path, page(path, f"{b['id']} family tree", f"{b['direct']:,} models are built directly on {b['id']} ({b['descendants']:,} descendants in total): fine-tunes, quantizations, adapters and merges.",
                         body, f"#families?tree={b['id']}"))
        fam_links.append(f'<li><a href="../../{esc(path)}">{esc(b["id"])}</a>: {b["direct"]:,} direct derivatives</li>')
    write("p/families/", page("p/families/", "Who builds on whom: model family trees", "Which base models spawn the most fine-tunes, quantizations, adapters and merges on Hugging Face.",
                              "<ul>" + "".join(fam_links) + "</ul>", "#families"))

    # ---- newsletter
    nl_links = []
    for slug_, d in issues.items():
        if d.get("kind") != "weekly":
            continue
        path = f"p/newsletter/{slug_}/"
        write(path, page(path, f"HF Observatory weekly: {d['title']}", d["intro"][0], md_to_html(d["markdown"]), f"#newsletter?issue={slug_}",
                         {"@context": "https://schema.org", "@type": "NewsArticle", "headline": d["title"], "datePublished": d["to"]}))
        nl_links.append(f'<li><a href="../../{esc(path)}">{esc(d["title"])}</a></li>')
    write("p/newsletter/", page("p/newsletter/", "The week on Hugging Face", "A weekly summary of new, removed and rising open models on Hugging Face.",
                                "<ul>" + "".join(nl_links) + "</ul>", "#newsletter"))

    urls = [SITE_URL] + [SITE_URL + p for p in written]
    (site / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                                      + "".join(f"<url><loc>{esc(u)}</loc></url>\n" for u in urls) + "</urlset>\n", encoding="utf-8")
    (site / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {SITE_URL}sitemap.xml\n", encoding="utf-8")
    return len(written)
