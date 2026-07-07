# qkb — Findable Personal Knowledge for Humans and Agents

| | |
|---|---|
| **Status** | Draft for review |
| **Date** | 2026-07-06 |
| **Format** | 1-pager (Lenny Rachitsky style) |
| **Related** | [DESIGN.md](DESIGN.md) (technical design) · [ADRs](adr/architecture-decisions.md) |

---

## Description: What is it?

qkb (Query Knowledge Base) is an on-device hybrid search engine for an Obsidian vault that understands YAML frontmatter metadata. It combines BM25 keyword search and vector semantic search over locally stored embeddings, exposed two ways: a CLI for humans and an MCP server for LLM agents. It ships as an installable Python package (`pip install qkb-search`).

## Problem: What problem is this solving?

Knowledge captured in the vault — meeting transcripts, AI-generated notes, articles, reference docs — is only findable by exact keyword or by remembering where it's filed. Conceptual queries ("what did the specialist say about switching formula?") fail unless you recall the literal words used. LLM agents are worse off: they have no structured access to the vault at all, so they either grep files or go without personal context. Related documents that belong together (a transcript and its AI notes from the same recording) must be hunted down separately.

## Why: How do we know this is a real problem?

- **Direct experience**: a transcription pipeline generates transcript + notes pairs weekly; retrieving them later routinely fails on keyword search alone.
- **Obsidian's built-in search is keyword-only** — no semantic retrieval, no cross-document relationship surfacing.
- **The approach is validated**: QMD (Tobi Lütke) proves the hybrid BM25 + vector + RRF architecture on the same stack; Anthropic's Contextual Retrieval research and multiple public personal-KB projects confirm SQLite + sqlite-vec + local embeddings works at personal scale.
- `[ASSUMPTION — needs validation]` Frontmatter-scoped opt-in (`context`/`source`) captures the notes that matter; validated during dogfooding.

## Success: How do we know if we've solved it?

- **Primary**: On a golden set of 10 known-answer queries against the real vault, hybrid search (`qkb query`) returns the intended document in the top 3 results for **at least 8 of 10** — via both CLI and MCP.
- **Secondary**: Full-vault ingest completes without errors; a no-change re-ingest finishes in under 5 seconds; keyword search returns in under 50 ms, hybrid in under 1 s (excluding first-call model load).
- **Secondary**: When a hit has siblings (shared `source`), they appear in the result without a second query.
- **Guardrail**: The vault is never modified — ingestion is strictly read-only. Notes without `context`/`source` are never indexed (opt-in contract), and previously indexed notes that opt out are removed on the next ingest.

## Audience: Who are we building for?

Two first-class consumers, equal priority: **the vault owner at the terminal** (fast, filterable search that beats opening Obsidian) and **LLM agents via MCP** (Claude Code/Desktop answering questions from vault content, with document retrieval by stable UUID). Explicitly not building for: multi-user setups, non-Obsidian sources, or web UI consumers in this phase — though the public package means other Obsidian users with a compatible frontmatter setup can adopt it.

## What: Roughly, what does it look like?

- `qkb ingest` — walks the vault, indexes opted-in notes (frontmatter contract), incremental via content hashing.
- `qkb search` / `vsearch` / `query` — keyword, semantic, and hybrid (RRF-fused) search, with filters: `--context`, `--type`, `--tags`, `--date-from/to`. `--rerank` exists but returns "not configured" until Phase 2.
- `qkb get <UUID>` — retrieve any document as file path, `obsidian://` URI, or raw markdown.
- `qkb mcp` — stdio MCP server exposing `qkb`, `qkb_get`, `qkb_status` tools.
- Local-first: embeddings via Ollama by default; OpenAI-compatible remote providers configurable. GitHub Actions CI (lint, types, tests) and tag-triggered release to PyPI.

## How: What is the experiment plan?

Dogfooding is the experiment. Build against synthetic fixtures (unit tests use a fake embedding provider — no Ollama in CI), then run the golden-query benchmark against the real vault as acceptance. If hybrid quality misses the 8/10 bar, tune chunk size, FTS5 column weights, and RRF candidate counts before expanding scope.

## When: Milestones

Executed as an autonomous agent build; sequence over dates. **M1** repo + CI + package skeleton → **M2** schema + ingestion pipeline → **M3** search tiers 1–3 + filters + siblings → **M4** CLI → **M5** MCP server → **M6** golden-query acceptance against the real vault → **v0.1.0 on PyPI**. Phase 2 (LLM re-ranking, HTTP API) and Phase 3 (attachment extraction) are out of scope and tracked in DESIGN.md.
