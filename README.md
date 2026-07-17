# qkb — Query Knowledge Base

An on-device hybrid search engine for Obsidian vaults that understands YAML frontmatter metadata. Combines BM25 keyword search (SQLite FTS5) and vector semantic search (sqlite-vec) with metadata filtering, sibling-document surfacing, and two first-class interfaces: a CLI for humans and an MCP server for LLM agents.

**Status**: Phase 1 (ingest, search tiers 1–3, CLI, MCP stdio).

## Quickstart

    pip install qkb-search
    ollama pull embeddinggemma
    qkb ingest                       # index your vault (reads ~/.config/qkb/config.toml)
    qkb query "certificate renewal"  # hybrid search
    qkb mcp                          # stdio MCP server for Claude Code / Desktop

Claude Code MCP registration:

    claude mcp add qkb -- qkb mcp

## Documents

- [PRD](docs/PRD.md) — what we're building and why
- [Technical Design](docs/DESIGN.md) — architecture, schema, search algorithms
- [Architecture Decision Records](docs/adr/architecture-decisions.md) — the decision log
- [Implementation Plans](docs/plans/) — milestone-by-milestone build plan

## The Short Version

Notes opt in to indexing via frontmatter (`context` and/or `source` properties). An ingestion pipeline walks the vault, chunks markdown with structure-aware break-point scoring, embeds locally via Ollama, and stores everything in a single SQLite file. A search engine layers BM25 (document-level, weighted columns), vector similarity (chunk-level), and Reciprocal Rank Fusion on top — exposed as `qkb search` / `vsearch` / `query`, `qkb get <UUID>`, and `qkb mcp`.

Inspired by [QMD](https://github.com/tobi/qmd)'s search architecture, adapted for structured knowledge systems with frontmatter metadata.

## Installation (once released)

```bash
pip install qkb-search   # or: pipx install qkb-search / uvx --from qkb-search qkb
pip install 'qkb-search[local]'   # or: uv tool install 'qkb-search[local]'
```

The package installs the `qkb` command. Requires Python ≥3.11 and, for local embeddings, [Ollama](https://ollama.com) with `embeddinggemma` pulled (multilingual, CPU-friendly; other models configurable).

### No Ollama? Use the in-process provider

The `[local]` extra runs embeddings in-process via `llama-cpp-python` — no Ollama service required. Useful on a laptop used for occasional searches where a resident Ollama process isn't worth keeping around.

```toml
[embedding]
provider = "local"
```

The first `qkb ingest` downloads the GGUF (~300 MB, one-time, cached under `~/.cache/qkb/models/`) and then embeds normally. Switching providers forces a full re-embed — run `qkb ingest --full` after changing `provider`.

## License

MIT
