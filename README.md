# qkb — Query Knowledge Base

An on-device hybrid search engine for Obsidian vaults that understands YAML frontmatter metadata. Combines BM25 keyword search (SQLite FTS5) and vector semantic search (sqlite-vec) with metadata filtering, sibling-document surfacing, and two first-class interfaces: a CLI for humans and an MCP server for LLM agents.

**Status**: TypeScript rewrite — feature-parity with the Python `v0.3.0` original, plus multi-provider embeddings and GPU-accelerated (Metal) local embedding on Apple Silicon.

## Quickstart

**1. Install** (isolated global CLI):

```bash
npm i -g @miguelarios/qkb
```

Requires Node ≥20. No separate service, no compile step for the default provider — `node-llama-cpp` ships prebuilt native binaries (Metal-accelerated on Apple Silicon) that download automatically on install.

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

```bash
qkb status                       # verify config, vault, and model resolve
qkb ingest                       # keyword index — fast, no model needed
qkb search "certificate renewal" # keyword (BM25) search works right away
qkb embed                        # compute vectors (downloads the model once; resumable)
qkb query "certificate renewal"  # full hybrid (keyword + semantic) search
qkb mcp                          # stdio MCP server for Claude Code / Desktop
```

Indexing is split so nothing blocks for hours: **`qkb ingest`** builds the
keyword index in seconds (no model), so `qkb search` works immediately;
**`qkb embed`** then computes the vectors that power semantic/hybrid search.
`qkb embed` is **resumable** — Ctrl-C is safe, and re-running continues where
it left off — and `qkb status` shows how many vectors are still pending.

Claude Code MCP registration:

```bash
claude mcp add qkb -- qkb mcp
```

## Why the rewrite: Apple Silicon embedding is fast now

The Python original (`qkb-search`, still on PyPI — see [Migrating from the Python version](#migrating-from-the-python-version) below) runs embeddings via `onnxruntime`, which is **CPU-only on macOS**: a full re-embed of a ~3,000-note vault takes roughly **4 hours**. The TypeScript rewrite's default provider, `node-llama-cpp`, ships prebuilt **Metal-accelerated** binaries — the same full re-embed drops to **~10–15 minutes** on an Apple Silicon Mac. Same model (`embeddinggemma-300M`), same search quality; the win is entirely in embedding throughput.

## Embedding providers

Four interchangeable providers, set via `[embedding].provider` in `config.toml`:

| provider | how it runs | when to use |
|---|---|---|
| `llama` *(default)* | in-process via `node-llama-cpp` (GGUF, Metal-accelerated on Apple Silicon, prebuilt binaries — no compile) | just works, fastest on-device option, especially on Apple Silicon |
| `ollama` | the [Ollama](https://ollama.com) HTTP API | you already run Ollama (e.g. a Linux box or shared server) |
| `openai` | any OpenAI-compatible `/v1/embeddings` endpoint | OpenAI itself, Azure OpenAI, or a local server (LM Studio, vLLM, llamafile) |
| `fake` | deterministic hash-based vectors, no model | tests and CI only |

Switching provider or model changes the vectors, so run `qkb embed --full`
afterward to re-embed everything.

```toml
# ~/.config/qkb/config.toml — llama (default)
[embedding]
provider = "llama"
model = "embeddinggemma-300M-Q8_0"
dimension = 768
# local_gguf_repo / local_gguf_file / model_cache_dir also configurable — see below
```

```toml
# ~/.config/qkb/config.toml — ollama
[embedding]
provider = "ollama"
model = "embeddinggemma"
dimension = 768
ollama_host = "http://localhost:11434"
```

```toml
# ~/.config/qkb/config.toml — openai-compatible
[embedding]
provider = "openai"
model = "text-embedding-3-small"
dimension = 1536
openai_base_url = "https://api.openai.com"  # or a local/compatible endpoint
```

The OpenAI API key is read from the `QKB_OPENAI_API_KEY` environment
variable only — it's never stored in `config.toml`.

## Configuration reference

`~/.config/qkb/config.toml` (all keys optional; shown with their defaults).
`QKB_CONFIG=/path/to/alt-config.toml` points at a different config file
entirely.

```toml
[vault]
path = "~/Notes"
name = "Notes"

[database]
path = "~/.local/share/qkb/qkb.db"

[embedding]
provider = "llama"                                     # llama | ollama | openai | fake
model = "embeddinggemma-300M-Q8_0"
dimension = 768
ollama_host = "http://localhost:11434"
local_gguf_repo = "ggml-org/embeddinggemma-300M-GGUF"
local_gguf_file = "embeddinggemma-300M-Q8_0.gguf"
model_cache_dir = "~/.cache/qkb/models"
openai_base_url = ""                                   # optional override
# doc_template / query_template: optional explicit "{t}"-placeholder prompt
# templates, overriding the per-model default asymmetric prefixing.

[chunking]
target_tokens = 500
overlap_percent = 15

[search]
default_limit = 10
rrf_k = 60
vec_candidates = 30
fts_candidates = 30
fts_weights = [5.0, 3.0, 2.0, 1.0, 0.5]

[frontmatter]
# Optional alias mapping for non-default frontmatter property names, e.g.:
# id = ["uuid"]
# created = ["created", "date created"]
```

### Environment-variable overrides

Only the keys below have a `QKB_*` environment-variable override — `[chunking]`, `[search]`, and `[frontmatter]` keys do **not** (config-file-only). An env var always wins over `config.toml`.

| `config.toml` key | env var |
|---|---|
| `vault.path` | `QKB_VAULT_PATH` |
| `vault.name` | `QKB_VAULT_NAME` |
| `database.path` | `QKB_DB_PATH` |
| `embedding.provider` | `QKB_EMBEDDING_PROVIDER` |
| `embedding.model` | `QKB_EMBEDDING_MODEL` |
| `embedding.dimension` | `QKB_EMBEDDING_DIM` |
| `embedding.ollama_host` | `QKB_OLLAMA_HOST` |
| `embedding.doc_template` | `QKB_EMBEDDING_DOC_TEMPLATE` |
| `embedding.query_template` | `QKB_EMBEDDING_QUERY_TEMPLATE` |
| `embedding.local_gguf_repo` | `QKB_LOCAL_GGUF_REPO` |
| `embedding.local_gguf_file` | `QKB_LOCAL_GGUF_FILE` |
| `embedding.model_cache_dir` | `QKB_MODEL_CACHE_DIR` |
| `embedding.openai_base_url` | `QKB_OPENAI_BASE_URL` |
| *(no `config.toml` key — env only)* | `QKB_OPENAI_API_KEY` |

Plus `QKB_CONFIG`, which isn't a per-key override — it points qkb at a
different `config.toml` path entirely.

## MCP usage

`qkb mcp` runs a stdio MCP server exposing three tools to LLM agents:

- **`qkb`** — hybrid BM25 + vector search with the same filters as the CLI (`context`, `source`, `type`, `tags`, date range, `limit`).
- **`qkb_get`** — retrieve a single document by id (or unambiguous id prefix).
- **`qkb_status`** — index health: document/chunk/vector counts, contexts, pending-vector count.

Register with Claude Code:

```bash
claude mcp add qkb -- qkb mcp
```

Or point any MCP-compatible client at the `qkb mcp` stdio command directly.

## Homebrew

A single-file formula lives at `Formula/qkb.rb` in this repo (`depends_on "node"`, installs the published npm package). Until a dedicated `homebrew-qkb` tap exists, install it directly from the repo:

```bash
brew install --formula https://raw.githubusercontent.com/miguelarios/qkb/main/Formula/qkb.rb
```

## The Short Version

Notes opt in to indexing via frontmatter (`context` and/or `source` properties). An ingestion pipeline walks the vault, chunks markdown with structure-aware break-point scoring, embeds in-process (`node-llama-cpp`/GGUF by default; Ollama or an OpenAI-compatible endpoint optional), and stores everything in a single SQLite file. A search engine layers BM25 (document-level, weighted columns), vector similarity (chunk-level), and Reciprocal Rank Fusion on top — exposed as `qkb search` / `vsearch` / `query`, `qkb get <UUID>`, and `qkb mcp`.

Inspired by [QMD](https://github.com/tobi/qmd)'s search architecture and its GPU-fast native-binary distribution model, adapted for structured knowledge systems with frontmatter metadata.

## Documents

- [PRD](docs/PRD.md) — what we're building and why
- [Technical Design](docs/DESIGN.md) — architecture, schema, search algorithms
- [Architecture Decision Records](docs/adr/architecture-decisions.md) — the decision log
- [Implementation Plans](docs/plans/) — milestone-by-milestone build plan, including the [TypeScript rewrite plan](docs/plans/2026-07-20-typescript-rewrite.md)

## Migrating from the Python version

The original Python implementation (`qkb-search`, PyPI, `v0.3.0`) is kept in this repo at `legacy/python/` and remains installable (`pip install qkb-search` / `uv tool install qkb-search`) but is **superseded by this npm package** — no further Python releases are planned except emergency patches. Both share the same `~/.config/qkb/config.toml`, `~/.local/share/qkb/qkb.db`, and `~/.cache/qkb/models` paths, but switching between them (or between embedding providers) changes the vectors, so run `qkb embed --full` after switching.

## Development

```bash
npm ci
npm test          # vitest, offline (FakeProvider — no Ollama/OpenAI/model download)
npm run typecheck # tsc --noEmit
npm run lint       # biome check
npm run build       # tsc -p tsconfig.build.json -> dist/
npm run golden-queries -- ~/.config/qkb/golden_queries.yaml   # acceptance harness (needs a real index)
```

`npm run golden-queries` scores each query in the YAML file against the hybrid top-3 (PRD target: ≥80%); see `legacy/python/scripts/golden_queries.example.yaml` for the schema. Your real golden-queries file is personal vault data and must never be committed to this repo.

## License

MIT
