"""Golden-query acceptance harness (PRD success metric: >=8/10 in top 3).

Usage: python scripts/golden_queries.py [path-to-yaml]
Requires: an ingested database and the configured embedding provider running.
"""

from __future__ import annotations

import sys
from pathlib import Path

from qkb.config import load_config
from qkb.db import connect
from qkb.embed import get_provider
from qkb.search.filters import Filters
from qkb.search.hybrid import search
from qkb.search.results import hydrate


def load_queries(path: Path) -> list[dict]:
    # minimal YAML-subset parser to avoid a dependency: expects the example's shape
    import re

    queries, current = [], None
    for line in path.read_text().splitlines():
        if re.match(r"\s*-\s+query:", line):
            if current:
                queries.append(current)
            current = {"query": line.split(":", 1)[1].strip().strip('"')}
        elif current and ":" in line and line.strip():
            k, v = line.strip().split(":", 1)
            current[k.strip()] = v.strip().strip('"')
    if current:
        queries.append(current)
    return queries


def main() -> int:
    path = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else (Path.home() / ".config/qkb/golden_queries.yaml")
    )
    cfg = load_config()
    conn = connect(cfg.db_path, cfg.embedding_dim)
    provider = get_provider(cfg)
    hits = 0
    queries = load_queries(path)
    for q in queries:
        ranked = search(
            conn,
            cfg,
            provider,
            q["query"],
            Filters(context=q.get("context")),
            limit=3,
            tier="hybrid",
        )
        titles = [r["title"] for r in hydrate(conn, ranked)]
        ok = any(q["expect_title_contains"].lower() in (t or "").lower() for t in titles)
        hits += ok
        print(f"{'PASS' if ok else 'FAIL'}  {q['query']!r} -> {titles}")
    print(f"\n{hits}/{len(queries)} in top 3 (target: >=80%)")
    return 0 if len(queries) and hits / len(queries) >= 0.8 else 1


if __name__ == "__main__":
    sys.exit(main())
