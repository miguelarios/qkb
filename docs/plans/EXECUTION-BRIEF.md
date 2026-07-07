# qkb Phase 1 — Execution Brief

Mission for an autonomous session: build qkb Phase 1 end-to-end and prove it against the owner's real vault. Read `CLAUDE.md` first — its hard rules (public repo, no PII, read-only vault, no release tags) are non-negotiable.

## The work

Execute the implementation plan at `docs/plans/2026-07-06-phase1-mvp.md` from Task 1 through Task 16, in order. Honor each task's TDD cycle: failing test → implementation → passing test → lint/typecheck → commit. Check off plan checkboxes as you go. If a plan step conflicts with reality (SDK API drift, FTS5 syntax quirks, etc.), fix forward — the plan's interfaces and test assertions are the contract; its code is a strong draft. Debug failures systematically instead of retry-thrashing.

## Acceptance (Task 17 — the part that proves it works)

Run against the REAL vault, not fixtures:

1. Config: write `~/.config/qkb/config.toml` with `[vault] path = "~/Obsidian/Personal"`, `name = "Personal"` — only if it doesn't already exist.
2. Prerequisite: Ollama running with `embeddinggemma` pulled (`ollama pull embeddinggemma`). If Ollama isn't installed at all, stop and tell the owner — that's the one legitimate blocker.
3. `qkb ingest` completes cleanly; a second `time qkb ingest` finishes in <5s with `indexed=0`.
4. `python scripts/golden_queries.py` — uses the owner's real known-answer queries at `~/.config/qkb/golden_queries.yaml` — scores **≥8/10**. If below the bar: tune `fts_weights`, chunk size, and candidate counts per Task 17's guidance, re-ingest, re-run. Iterate until the bar is met or every documented tuning lever is exhausted (then report exactly what was tried and the best score).
5. Latency spot-checks (warm): `qkb search` <50ms, `qkb query` <1s.
6. Sibling check: a transcript/notes pair sharing a `source` surfaces each other under `siblings` in `--json` output.

## Done means ALL of:

- Tasks 1–16 implemented and committed (gitleaks-clean commits).
- `.venv/bin/pytest -q -m "not integration"` exits 0.
- `ruff check`, `ruff format --check`, and `mypy src` all clean.
- Acceptance items 3–6 above pass, with the golden-query score printed in the transcript.
- Pushed to `origin main` (skip only if no remote exists yet — say so in the report).

## Never

Tag a release or publish to PyPI. Copy vault content or `~/.config/qkb/golden_queries.yaml` into the repo. Weaken a test to make it pass. Skip acceptance because unit tests are green. Use `git commit --no-verify`.

## Final report

Tasks completed; test/lint status; ingest stats (counts + timings); golden-query score with per-query pass/fail; latency numbers; anything deferred and why.
