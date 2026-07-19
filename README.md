# qkb — Query Knowledge Base

An on-device hybrid search engine for Obsidian vaults that understands YAML frontmatter metadata. Combines BM25 keyword search (SQLite FTS5) and vector semantic search (sqlite-vec) with metadata filtering, sibling-document surfacing, and two first-class interfaces: a CLI for humans and an MCP server for LLM agents.

**Status**: Phase 1 (ingest, search tiers 1–3, CLI, MCP stdio).

## Quickstart

**1. Install** (isolated, like `pipx` / `npm -g`):

    uv tool install qkb-search

**2. Point qkb at your vault** — create `~/.config/qkb/config.toml`:

```toml
[vault]
path = "~/Documents/MyVault"   # your Obsidian vault (read-only to qkb)
name = "MyVault"               # used to build obsidian:// links
```

**3. Opt notes in.** Only notes whose frontmatter has a `context` and/or
`source` property are indexed — and an opted-in note also needs an `id` and
a parseable date (`created` or `date`):

```yaml
---
id: f47ac10b-58cc-4372-a567-0e02b2c3d401
context: homelab
created: 2026-03-15
---
```

**4. Index in two phases, then search:**

    qkb status                       # verify config, vault, and model resolve
    qkb ingest                       # keyword index — fast, no model needed
    qkb search "certificate renewal" # keyword (BM25) search works right away
    qkb embed                        # compute vectors (downloads the model once; resumable)
    qkb query "certificate renewal"  # full hybrid (keyword + semantic) search
    qkb mcp                          # stdio MCP server for Claude Code / Desktop

Indexing is split so nothing blocks for hours: **`qkb ingest`** builds the
keyword index in seconds (no model), so `qkb search` works immediately;
**`qkb embed`** then computes the vectors that power semantic/hybrid search.
`qkb embed` is **resumable** — Ctrl-C is safe, and re-running continues where
it left off — and `qkb status` shows how many vectors are still pending.

No separate service, no compile: embeddings run **in-process via ONNX Runtime**,
whose prebuilt wheels install with the package. The default model is
**embeddinggemma-300M** (multilingual — the same embedding model
[QMD](https://github.com/tobi/qmd) uses), cached after the first download.
Re-running `qkb ingest`/`qkb embed` is incremental: unchanged notes are skipped
and only new/changed chunks get embedded, so it's cheap to keep up to date.

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
Requires Python ≥3.11.

The default model is **embeddinggemma-300M** — the same embedding model QMD
uses. GGUF (QMD) and ONNX (qkb) are just different packagings of the same
weights for different runtimes; search quality comes from the model, not the
file format. The ~310 MB quantized ONNX downloads once on first `qkb ingest`
and is cached.

### Embedding providers

Three interchangeable providers, set via `[embedding].provider`:

| provider | how it runs | when to use |
|---|---|---|
| `local` *(default)* | in-process fastembed / ONNX (prebuilt wheels) | just works — no service, no compile |
| `ollama` | the [Ollama](https://ollama.com) HTTP API | you already run Ollama (e.g. a Linux box) |
| `gguf` | in-process llama-cpp-python (the `[gguf]` extra) | you want a specific GGUF; compiles on install |

Switching provider or model changes the vectors, so run `qkb ingest --full`
afterward to re-embed. Any model in
[fastembed's catalog](https://qdrant.github.io/fastembed/examples/Supported_Models/)
also works — e.g. a smaller/faster one:

```toml
# ~/.config/qkb/config.toml
[embedding]
provider = "local"
model = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"  # 384-dim, ~220 MB
dimension = 384
```

## License

MIT
