# qkb — Query Knowledge Base

An on-device hybrid search engine for Obsidian vaults that understands YAML frontmatter metadata. Combines BM25 keyword search (SQLite FTS5) and vector semantic search (sqlite-vec) with metadata filtering, sibling-document surfacing, and two first-class interfaces: a CLI for humans and an MCP server for LLM agents.

**Status**: Phase 1 (ingest, search tiers 1–3, CLI, MCP stdio).

## Quickstart

    uv tool install qkb-search       # isolated install (like pipx / npm -g)
    qkb status                       # check config, model, and vault
    qkb ingest                       # index your vault (downloads the embedding model once)
    qkb query "certificate renewal"  # hybrid search
    qkb mcp                          # stdio MCP server for Claude Code / Desktop

No separate service, no compile: embeddings run **in-process via fastembed/ONNX**,
whose prebuilt wheels install with the package. The multilingual embedding model
(~220 MB) downloads once on first `qkb ingest` and is cached. Point qkb at your
vault in `~/.config/qkb/config.toml` (`[vault] path = "..."`) — `qkb status`
shows what it resolved.

Claude Code MCP registration:

    claude mcp add qkb -- qkb mcp

## Documents

- [PRD](docs/PRD.md) — what we're building and why
- [Technical Design](docs/DESIGN.md) — architecture, schema, search algorithms
- [Architecture Decision Records](docs/adr/architecture-decisions.md) — the decision log
- [Implementation Plans](docs/plans/) — milestone-by-milestone build plan

## The Short Version

Notes opt in to indexing via frontmatter (`context` and/or `source` properties). An ingestion pipeline walks the vault, chunks markdown with structure-aware break-point scoring, embeds in-process (fastembed/ONNX by default; Ollama or GGUF optional), and stores everything in a single SQLite file. A search engine layers BM25 (document-level, weighted columns), vector similarity (chunk-level), and Reciprocal Rank Fusion on top — exposed as `qkb search` / `vsearch` / `query`, `qkb get <UUID>`, and `qkb mcp`.

Inspired by [QMD](https://github.com/tobi/qmd)'s search architecture, adapted for structured knowledge systems with frontmatter metadata.

## Installation

`qkb` is a command-line tool, so install it into an isolated environment —
the same idea as `pipx` or `npm i -g`:

```bash
# Recommended (uv):
uv tool install qkb-search

# Run without installing:
uvx --from qkb-search qkb query "certificate renewal"

# Alternatives (pipx isolates like uv; plain pip uses the current env):
pipx install qkb-search
pip install qkb-search
```

That's the whole setup — **no service, no compile.** The default embedding
provider runs in-process via **fastembed / ONNX Runtime**, whose prebuilt
wheels ship with the package (the C/C++ work is done upfront by the wheel
builders, the way QMD relies on node-llama-cpp's prebuilt native binaries).
Requires Python ≥3.11. The multilingual embedding model (~220 MB) downloads
once on first `qkb ingest` and is cached.

### Embedding providers

Three interchangeable providers, set via `[embedding].provider`:

| provider | how it runs | when to use |
|---|---|---|
| `local` *(default)* | in-process fastembed / ONNX (prebuilt wheels) | just works — no service, no compile |
| `ollama` | the [Ollama](https://ollama.com) HTTP API | you already run Ollama (e.g. a Linux box) |
| `gguf` | in-process llama-cpp-python (the `[gguf]` extra) | you want a specific GGUF; compiles on install |

Switching provider or model changes the vectors, so run `qkb ingest --full`
afterward to re-embed. To trade the light default model for more quality:

```toml
# ~/.config/qkb/config.toml
[embedding]
provider = "local"
model = "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"  # 768-dim
dimension = 768
```

## License

MIT
