---
description: Execute the qkb Phase 1 MVP plan end-to-end — do not stop until all tasks pass and acceptance succeeds
---

Execute the qkb Phase 1 MVP implementation plan at `docs/plans/2026-07-06-phase1-mvp.md` from start to finish. Read `CLAUDE.md` first — its hard rules (public repo, PII, read-only vault, no release tags) are non-negotiable.

**Goal state — do not stop until ALL of these are true:**

1. Every task in the plan (1–16) is implemented in order, each with its TDD cycle honored: failing test → implementation → passing test → lint/typecheck → commit. Check off plan checkboxes as you go.
2. The full unit suite passes: `.venv/bin/pytest -q -m "not integration"` — zero failures.
3. `ruff check`, `ruff format --check`, and `mypy src` are all clean.
4. Task 17 acceptance passes against the REAL vault:
   - Write `~/.config/qkb/config.toml` with `[vault] path = "~/Obsidian/Personal"`, `name = "Personal"` (only if it doesn't already exist).
   - Verify Ollama is running and `embeddinggemma` is pulled (`ollama pull embeddinggemma` if not). If Ollama isn't installed, stop and tell the owner — that's the one true blocker.
   - `qkb ingest` completes cleanly; a second `time qkb ingest` finishes in <5s with `indexed=0`.
   - `python scripts/golden_queries.py` (uses the owner's real queries at `~/.config/qkb/golden_queries.yaml`) scores **≥8/10**. If below: tune `fts_weights`, chunking, and candidate counts per the plan's Task 17 guidance, re-ingest, and re-run — iterate until the bar is met or you've exhausted the documented tuning levers (then report exactly what was tried and the best score).
   - Latency spot-checks: `qkb search` <50ms warm, `qkb query` <1s warm.
   - Sibling check: a transcript/notes pair sharing a `source` surfaces each other under `siblings` in `--json` output.
5. Everything is committed (gitleaks-clean) and pushed to `origin main`.

**How to work:** prefer superpowers:subagent-driven-development (fresh subagent per plan task, review between tasks); superpowers:executing-plans is the fallback. If a plan step conflicts with reality (SDK API drift, FTS5 syntax, etc.), fix forward — the plan's interfaces and test assertions are the contract, its code is a strong draft. Debug failures with superpowers:systematic-debugging instead of retry-thrashing.

**Do NOT:** tag a release, publish to PyPI, copy vault content or the golden-queries file into the repo, weaken a test to make it pass, or skip acceptance because unit tests are green.

**When done, report:** tasks completed, final test/lint status, ingest stats (counts + timings), golden-query score with per-query pass/fail, latency numbers, and anything deferred with a reason.

$ARGUMENTS
