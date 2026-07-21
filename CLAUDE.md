# qkb — Project Instructions

Hybrid BM25 + vector search for Obsidian vaults. The project is mid-rewrite from Python to
TypeScript (Node ≥20, `better-sqlite3` + `sqlite-vec`, `commander` CLI, `@modelcontextprotocol/sdk`
stdio server) — see `docs/plans/2026-07-20-typescript-rewrite.md`. The TS project lives at the repo
root; the original Python implementation (`qkb-search`, v0.3.0, published on PyPI) is preserved and
still runnable under `legacy/python/` and is the authoritative behavioral spec each port task
matches against. Package `@miguelarios/qkb`, command `qkb`.

## Source of truth

- `docs/plans/2026-07-20-typescript-rewrite.md` — the TypeScript rewrite plan (18 tasks). Execute in order; each task ports the cited `legacy/python/src/qkb/<module>.py` + `legacy/python/tests/test_<module>.py`.
- `docs/plans/2026-07-06-phase1-mvp.md` — the original Python implementation plan, kept for history.
- `docs/DESIGN.md` — technical design. `docs/adr/architecture-decisions.md` — decision log; **ADRs win over DESIGN.md on conflict**.
- `docs/PRD.md` — success criteria (unchanged by the rewrite). Primary: ≥8/10 golden queries return the target doc in the top 3.

## Commands

```bash
# TypeScript (repo root)
npm test                                   # unit tests (vitest, no Ollama, FakeProvider)
npx biome check . && npx tsc --noEmit      # lint/format + typecheck
npm run build                              # tsc -> dist/

# Legacy Python (legacy/python/) — reference/spec only, not the shipping code
cd legacy/python && ../../.venv/bin/pytest -q -m "not integration"
../../.venv/bin/ruff check . && ../../.venv/bin/ruff format . && ../../.venv/bin/mypy src
```

## Hard rules

- **This repo is public.** No real names, personal contexts, private hostnames/IPs, or vault content in code, tests, fixtures, docs, or commit messages. Test data uses synthetic values (Alice Smith, example.com, `homelab-traefik`-style contexts). The gitleaks pre-commit hook enforces this — if it blocks a commit, fix the data; NEVER `--no-verify`.
- The owner's real golden-query file lives at `~/.config/qkb/golden_queries.yaml` — read/run it locally, never copy it (or its contents) into the repo.
- The Obsidian vault is read-only. Never write into it.
- Unit tests must pass offline (TS: no model download, no Ollama, no network — use the `fake` provider; Python: anything needing Ollama gets `@pytest.mark.integration`).
- Don't tag releases (`v*`) — tagging triggers a publish (PyPI for legacy Python; npm for the TS package, Task 17) and is owner-only.
