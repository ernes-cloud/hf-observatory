"""Family trees: which base models spawn the most derivatives.

Edges come from the Hub tags ``base_model:<relation>:<parent>`` (relation is
finetune, quantized, adapter or merge). When a model declares a ``base_model``
but has no such tag, the edge is kept with the generic relation "derivative".
Ids are matched case-insensitively. Only live models count as derivatives.
"""

from __future__ import annotations

from collections import defaultdict, deque

from .common import rows

RELATIONS = ("finetune", "quantized", "adapter", "merge", "derivative")
TOP_BASES = 150  # bases listed in the index
TREES = 60  # bases with a full, navigable tree file
ROOT_CHILDREN = 120  # children kept at the root of a tree
CHILDREN = 25  # children kept at deeper levels
MAX_DEPTH = 4


def _edges(models: list[dict]) -> dict[str, list[tuple[str, str]]]:
    """parent (lowercase) → [(child id, relation)]."""
    children: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for m in models:
        seen: set[str] = set()
        for tag in m["tags"] or []:
            if not tag.startswith("base_model:"):
                continue
            parts = tag.split(":", 2)
            if len(parts) == 3 and parts[1] in RELATIONS:
                parent = parts[2].strip().lower()
                if parent and parent != m["id"].lower() and parent not in seen:
                    seen.add(parent)
                    children[parent].append((m["id"], parts[1]))
        if not seen and m["base_model"]:
            for p in m["base_model"].split(","):
                parent = p.strip().lower()
                if parent and parent != m["id"].lower() and parent not in seen:
                    seen.add(parent)
                    children[parent].append((m["id"], "derivative"))
    return children


def build(con) -> tuple[dict, dict[int, dict]]:
    models = rows(con, """
        SELECT id, tags, nullif(trim(base_model), '') AS base_model, downloads_30d AS dl, likes,
               pipeline_tag AS task, parameters, family
        FROM m WHERE NOT removed""")
    info = {m["id"].lower(): m for m in models}
    children = _edges(models)
    parents_of: dict[str, list[str]] = defaultdict(list)
    for parent, kids in children.items():
        for cid, _ in kids:
            parents_of[cid.lower()].append(parent)

    def display_id(key: str) -> str:
        return info[key]["id"] if key in info else _canonical.get(key, key)

    # Keep the parent's original casing as written by its children when it is not in the dataset.
    _canonical: dict[str, str] = {}
    for m in models:
        for tag in m["tags"] or []:
            parts = tag.split(":", 2)
            if len(parts) == 3 and parts[0] == "base_model":
                _canonical.setdefault(parts[2].strip().lower(), parts[2].strip())
        if m["base_model"]:
            for p in m["base_model"].split(","):
                _canonical.setdefault(p.strip().lower(), p.strip())

    def descendants(root: str) -> tuple[int, int, int]:
        """(count, summed downloads, max depth) of everything below root (cycle-safe)."""
        seen = {root}
        q = deque([(root, 0)])
        total = dl = depth = 0
        while q:
            node, d = q.popleft()
            for cid, _ in children.get(node, ()):
                k = cid.lower()
                if k in seen:
                    continue
                seen.add(k)
                total += 1
                dl += info[k]["dl"] or 0
                depth = max(depth, d + 1)
                q.append((k, d + 1))
        return total, dl, depth

    ranked = sorted(children, key=lambda p: -len(children[p]))[: TOP_BASES * 2]
    bases = []
    for key in ranked:
        kids = children[key]
        by_rel = {r: 0 for r in RELATIONS}
        for _, rel in kids:
            by_rel[rel] += 1
        n_desc, desc_dl, depth = descendants(key)
        own = info.get(key)
        bases.append({
            "id": display_id(key),
            "in_dataset": own is not None,
            "family": own["family"] if own else None,
            "task": own["task"] if own else None,
            "downloads": own["dl"] if own else None,
            "direct": len(kids),
            "by_relation": by_rel,
            "descendants": n_desc,
            "descendant_downloads": desc_dl,
            "depth": depth,
            "parents": [display_id(p) for p in parents_of.get(key, [])][:3],
        })
    bases.sort(key=lambda b: (-b["direct"], -b["descendants"]))
    bases = bases[:TOP_BASES]

    # Family detection for bases not in the dataset: reuse the family of their children.
    fam_of_children: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for key in [b["id"].lower() for b in bases]:
        for cid, _ in children[key]:
            f = info.get(cid.lower(), {}).get("family")
            if f:
                fam_of_children[key][f] += 1
    for b in bases:
        if not b["family"]:
            counts = fam_of_children.get(b["id"].lower())
            if counts:
                b["family"] = max(counts.items(), key=lambda kv: kv[1])[0]

    # Relation totals across the whole hub.
    totals = {r: 0 for r in RELATIONS}
    for kids in children.values():
        for _, rel in kids:
            totals[rel] += 1
    derived_models = sum(1 for m in models if m["id"].lower() in parents_of)

    # By family: how many derivatives point at a base of that family.
    by_family: dict[str, dict[str, int]] = defaultdict(lambda: {r: 0 for r in RELATIONS})
    for m in models:
        key = m["id"].lower()
        if key in parents_of and m["family"]:
            rels = {rel for p in parents_of[key] for cid, rel in children[p] if cid.lower() == key}
            for rel in rels or {"derivative"}:
                by_family[m["family"]][rel] += 1
    family_rows = sorted(
        ({"family": f, **v, "total": sum(v.values())} for f, v in by_family.items()),
        key=lambda r: -r["total"],
    )

    def tree(key: str, depth: int, seen: set[str]) -> dict:
        kids = [(cid, rel) for cid, rel in children.get(key, ()) if cid.lower() not in seen]
        kids.sort(key=lambda kr: -((info.get(kr[0].lower()) or {}).get("dl") or 0))
        limit = ROOT_CHILDREN if depth == 0 else CHILDREN
        node: dict = {}
        if depth < MAX_DEPTH and kids:
            shown = kids[:limit]
            seen = seen | {c.lower() for c, _ in shown}
            out = []
            for cid, rel in shown:
                k = cid.lower()
                sub = tree(k, depth + 1, seen)
                m = info.get(k, {})
                child = {"i": m.get("id", cid), "r": RELATIONS.index(rel), "d": m.get("dl") or 0}
                if m.get("parameters"):
                    child["p"] = round(m["parameters"] / 1e6, 1)
                child.update(sub)
                out.append(child)
            node["c"] = out
            if len(kids) > limit:
                hidden = {r: 0 for r in RELATIONS}
                for _, rel in kids[limit:]:
                    hidden[rel] += 1
                node["more"] = len(kids) - limit
        if kids:
            node["n"] = len(kids)
        return node

    trees = {}
    for idx, b in enumerate(bases[:TREES]):
        key = b["id"].lower()
        root = {"i": b["id"], "d": b["downloads"] or 0, **tree(key, 0, {key})}
        trees[idx] = {"base": b, "relations": RELATIONS, "tree": root}
        b["tree"] = idx

    index = {
        "relations": RELATIONS,
        "totals": totals,
        "derived_models": derived_models,
        "live_models": len(models),
        "bases": bases,
        "families": family_rows,
    }
    return index, trees
