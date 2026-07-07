# qkb — Project Instructions

Hybrid BM25 + vector search for Obsidian vaults. Python ≥3.11, SQLite (FTS5 + sqlite-vec), Click CLI, MCP stdio server. Distribution `qkb-search`, import package `qkb`, command `qkb`.

## Source of truth

- `docs/plans/2026-07-06-phase1-mvp.md` — the implementation plan (17 TDD tasks, complete code). Execute in order.
- `docs/DESIGN.md` — technical design. `docs/adr/architecture-decisions.md` — decision log; **ADRs win over DESIGN.md on conflict**.
- `docs/PRD.md` — success criteria. Primary: ≥8/10 golden queries return the target doc in the top 3.

## Commands

```bash
.venv/bin/pytest -q -m "not integration"   # unit tests (no Ollama, FakeProvider)
.venv/bin/ruff check . && .venv/bin/ruff format . && .venv/bin/mypy src
python scripts/golden_queries.py           # acceptance vs real vault (needs Ollama + ingest)
```

## Hard rules

- **This repo is public.** No real names, personal contexts, private hostnames/IPs, or vault content in code, tests, fixtures, docs, or commit messages. Test data uses synthetic values (Alice Smith, example.com, `homelab-traefik`-style contexts). The gitleaks pre-commit hook enforces this — if it blocks a commit, fix the data; NEVER `--no-verify`.
- The owner's real golden-query file lives at `~/.config/qkb/golden_queries.yaml` — read/run it locally, never copy it (or its contents) into the repo.
- The Obsidian vault is read-only. Never write into it.
- Unit tests must pass offline. Anything needing Ollama gets `@pytest.mark.integration`.
- Don't tag releases (`v*`) — tagging triggers PyPI publish and is owner-only.
