# qkb — Query Knowledge Base

An on-device hybrid search engine for Obsidian vaults that understands YAML frontmatter metadata. Combines BM25 keyword search (SQLite FTS5) and vector semantic search (sqlite-vec) with metadata filtering, sibling-document surfacing, and two first-class interfaces: a CLI for humans and an MCP server for LLM agents.

**Status**: Pre-implementation — design and planning docs complete, code in progress.

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
```

The package installs the `qkb` command. Requires Python ≥3.11 and, for local embeddings, [Ollama](https://ollama.com) with `embeddinggemma` pulled (multilingual, CPU-friendly; other models configurable).

## License

MIT
