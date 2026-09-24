# qkb — Query Knowledge Base

An on-device hybrid search engine for Obsidian vaults that understands YAML frontmatter metadata. Combines BM25 keyword search (SQLite FTS5) and vector semantic search (sqlite-vec) with metadata filtering, sibling-document surfacing, and two first-class interfaces: a CLI for humans and an MCP server for LLM agents.

**Status**: v0.5 on npm — a TypeScript rewrite of the original Python `qkb-search`, with multi-provider embeddings and GPU-accelerated (Metal) local embedding on Apple Silicon. The roadmap lives in GitHub issues; the MVP is tracked in [#19](https://github.com/miguelarios/qkb/issues/19).

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

**3. Give notes an `id`.** Every note whose frontmatter has an `id` is
indexed; that id is how qkb tells notes apart, so it must be unique. Nothing
else is required: the date falls back from `date` to `created` to `modified`
to the file's modification time, and the title falls back to the file name.

```yaml
---
id: f47ac10b-58cc-4372-a567-0e02b2c3d401
---
```

`qkb ingest` reports how many notes were skipped for having no `id`.

**4. Index in two phases, then search:**

```bash
qkb status                       # verify config, vault, and model resolve
qkb ingest                       # keyword index — fast, no model needed
qkb search "certificate renewal" # keyword (BM25) search works right away
qkb embed                        # compute vectors (downloads the model once; resumable)
qkb query "certificate renewal"  # full hybrid (keyword + semantic) search
qkb mcp                          # stdio MCP server for Claude Code / Desktop
qkb mcp --http --watch           # or: one long-lived HTTP MCP server that keeps itself indexed
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

[search.fts_weights]      # keyword-ranking weight per field (0 = ignore)
title = 5.0
aliases = 5.0
headings = 3.0
tags = 3.0
fields = 2.0              # declared [frontmatter.fields]
body = 1.0
type = 0.5

[frontmatter]
# Which property names feed each core field (first present wins). Defaults:
# id       = ["id"]
# type     = ["type"]
# title    = ["title"]            # falls back to the file name
# aliases  = ["aliases", "alias"]
# date     = ["date"]
# created  = ["created", "date created"]
# modified = ["modified", "updated", "date modified"]
# tags     = ["tags", "tag"]

[frontmatter.fields]
# Optional: extra properties to search, embed, return and describe to agents
# (see "Extra frontmatter properties" below), e.g.:
# project = "Project this note belongs to"

[mcp]
host = "127.0.0.1"        # HTTP transport only (`qkb mcp --http`)
port = 8181
allowed_origins = []      # browser origins allowed besides loopback; ["*"] disables the check

[watch]
interval = 300            # seconds between re-index runs in watch mode

[rerank]                  # see "Reranking and query expansion"
enabled = false
provider = "llama"        # llama | fake
gguf_repo = "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF"
gguf_file = "qwen3-reranker-0.6b-q8_0.gguf"
candidates = 30           # top hybrid hits the reranker re-scores

[expansion]
enabled = false
provider = "llama"        # llama | fake
gguf_repo = "tobil/qmd-query-expansion-1.7B-gguf"
gguf_file = "qmd-query-expansion-1.7B-q4_k_m.gguf"
max_variants = 4
```

Several vaults: replace `[vault]` with a list (see "Multiple vaults" below):

```toml
[[vaults]]
name = "Personal"
path = "~/Documents/Personal"

[[vaults]]
name = "AgentWiki"
path = "~/agent-wiki"
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
| `mcp.host` | `QKB_MCP_HOST` |
| `mcp.port` | `QKB_MCP_PORT` |
| `mcp.allowed_origins` | `QKB_ALLOWED_ORIGINS` (comma-separated) |
| `watch.interval` | `QKB_WATCH_INTERVAL` |
| `rerank.enabled` | `QKB_RERANK` |
| `rerank.provider` | `QKB_RERANK_PROVIDER` |
| `expansion.enabled` | `QKB_EXPANSION` |
| `expansion.provider` | `QKB_EXPANSION_PROVIDER` |

`QKB_VAULT_PATH` names exactly one vault: when set, it replaces a
configured `[[vaults]]` list.

Plus `QKB_CONFIG`, which isn't a per-key override — it points qkb at a
different `config.toml` path entirely.

## MCP usage

qkb exposes three tools to LLM agents:

- **`qkb`** — hybrid BM25 + vector search with the same filters as the CLI (`type`, `tags`, date range, `vaults`, `fields`, `limit`), plus optional `rerank` and `expand` (defaults from `[rerank]`/`[expansion]`). Its description lists your vaults and declared fields, so an agent knows what it can filter on. Each result lists its related notes.
- **`qkb_get`** — retrieve a single document by id (or unambiguous id prefix), including every stored frontmatter property and all related notes (`include_related: false` to skip them).
- **`qkb_status`** — index health: document/chunk/vector counts, per-vault counts, declared fields and their most common values (`field_values`), so an agent can build `fields` filters.

It speaks two transports:

**stdio** (default) — the client spawns qkb as a subprocess:

```bash
claude mcp add qkb -- qkb mcp
```

**Streamable HTTP** — one long-lived process, one model load, any number of
clients (local agents, or other machines on your network):

```bash
qkb mcp --http                          # http://127.0.0.1:8181/mcp
qkb mcp --http --port 9000 --watch      # custom port, re-index on a timer
qkb mcp --http --host 0.0.0.0           # listen on all interfaces (containers, LAN)
```

```bash
claude mcp add --transport http qkb http://127.0.0.1:8181/mcp
```

The HTTP server is stateless (`POST /mcp`, JSON responses) and also serves
`GET /health`. It binds to loopback by default. Requests from a browser page
on another origin are refused unless that origin is listed in
`mcp.allowed_origins` / `QKB_ALLOWED_ORIGINS` (protection against DNS
rebinding). There is no authentication: on a shared network, keep it behind
your firewall or a reverse proxy that adds auth.

## Keeping the index fresh

`qkb mcp --watch` (stdio or HTTP) and the standalone `qkb watch` re-run the
incremental `ingest` + `embed` every `watch.interval` seconds (default 300).
Changes from a sync client, an editor, or an agent writing notes show up
within one interval. A no-change pass is cheap (content hashes), passes never
overlap, and a failed pass (vault unmounted, embedding host down) is logged
without stopping the server. The database runs in WAL mode, so a separate
`qkb ingest` can also run while a server is serving.

As a safety net, ingest refuses to run when a vault that has indexed notes
suddenly contains none. That usually means an unmounted volume, not a real
mass deletion. To really drop a vault, remove it from the config: its notes
are then de-indexed.

## Multiple vaults

List several `[[vaults]]` (see the configuration reference) and qkb indexes
them into one database. Every result carries its `vault`, `obsidian://`
links use each note's own vault name, and searches can be limited:

```bash
qkb query "deploy checklist" --vault AgentWiki     # repeatable: --vault A --vault B
```

MCP: `{"query": "...", "vaults": ["AgentWiki"]}`. `qkb status` shows counts
per vault.

Note `id`s are unique across all vaults: the same id in a second vault is
skipped and reported as a duplicate, exactly like a duplicate within one
vault. A note moved from one vault to another is followed (not re-embedded).

## Ranking and related notes

Keyword search weighs where a word appears, not just whether it does: a
match in the title or an alias counts most, then headings and tags, then
declared fields, then body text (`[search.fts_weights]` tunes each). A note
titled, aliased or headed with your query words beats one that merely
mentions them. Headings inside fenced code blocks are ignored.

Every result lists **related notes**:

- `links_to`: notes it links to with `[[wikilinks]]` (or `![[embeds]]`), in
  the order they appear. A link resolves by file name, vault path, title or
  alias, and one written before its target exists starts resolving once the
  target is indexed;
- `linked_from`: notes that link to it (backlinks);
- `same_source`: notes sharing its `source` property (e.g. several clips of
  one web page, or a transcript and the notes taken from it).

Search results show up to 10 related notes each; `qkb get` shows them all.

## Reranking and query expansion

Two optional, local-model stages sit around hybrid search. Both are off by
default, run in-process through `node-llama-cpp` (the models download once
to `model_cache_dir`), and fall back to plain search with a warning if the
model fails.

- **Reranking** (`qkb query --rerank`, MCP `rerank: true`, or `[rerank]
  enabled = true`): a cross-encoder (Qwen3-Reranker-0.6B, ~640 MB) reads the
  query with each of the top `candidates` hits (title, declared fields and
  the best-matching passage) and scores the fit. The score is blended with
  the retrieval rank, trusting retrieval more at the top: a confident
  reranker can lift a deep hit, but can't bury an exact title match.
- **Query expansion** (`qkb query --expand`, MCP `expand: true`, or
  `[expansion] enabled = true`): a small fine-tuned model (~1.1 GB) rewrites
  the query into a few keyword and paraphrase variants. Each variant's
  results are fused in, with the original query weighted double. Helps
  short or vaguely worded queries; adds a second or two per search.

`--no-rerank` / `--no-expand` (or `false` over MCP) turn a stage off for one
search when the config enables it. These are the same models QMD uses.

## Extra frontmatter properties

The core properties (`id`, `type`, `title`, `aliases`, `date`, `created`,
`modified`, `tags`) are always understood. Any other property is stored (and
returned by `qkb get`), but by default it doesn't affect search. Declare the
ones that matter:

```toml
[frontmatter.fields]
project   = "Project this note belongs to"
attendees = "People present in a meeting"
source    = "Where a web clip or transcript came from"
```

Declared properties are:

- **searchable**: keyword search matches their values (`fts_weights.fields` tunes the weight);
- **embedded**: prepended to each chunk's text as `project: Apollo` lines, so semantic search sees them;
- **returned**: as a `fields` object in `--json`, `qkb get` and MCP results;
- **filterable**: `--field project=Apollo` (repeatable, AND) / MCP `fields: {"project": "Apollo"}`. The match is case-insensitive, and a list property matches any one of its items;
- **described to agents**: each key and its description appear in the `qkb` tool description and in `qkb_status`.

Declaring a new field, or editing a declared value, refreshes the affected
notes on the next `ingest` and re-embeds just those notes on the next
`embed`. No `--full` is needed. `qkb fields` lists each declared field with
its description and most common values.

Filtering works on any stored property, declared or not: `--field
source=clip-2026` matches notes whose `source` is that value. (`--context X`
and `--source X` still work, as shorthand for `--field context=X` and
`--field source=X`.)

## Upgrading to 0.6

0.6 changes the index format (every note with an `id` is now indexed, and
aliases, headings and links are stored). The first qkb 0.6 command resets an
older index and says so; rebuild it with:

```bash
qkb ingest && qkb embed
```

## Running as a service (Docker)

The `Dockerfile` builds an image that serves HTTP MCP on port 8181 and
re-indexes on a timer (`qkb mcp --http --watch`). Mount the vault read-only
at `/vault` and a volume at `/data` (index and model cache). A config file,
if you need `[[vaults]]` or `[frontmatter.fields]`, goes at
`/config/config.toml`.

```bash
docker build -t qkb .
docker run -d -p 8181:8181 \
  -v /srv/vault:/vault:ro -v qkb-data:/data \
  -e QKB_VAULT_PATH=/vault -e QKB_VAULT_NAME=Notes \
  -e QKB_EMBEDDING_PROVIDER=ollama -e QKB_EMBEDDING_MODEL=embeddinggemma \
  -e QKB_OLLAMA_HOST=http://gpu-host.example.com:11434 \
  qkb
```

`docker-compose.example.yml` shows the same setup next to a vault that
another container keeps in sync. The image embeds through Ollama by default.
It leaves out node-llama-cpp's CUDA builds, so `provider = "llama"` inside
the container runs on the CPU.

## Homebrew

A single-file formula lives at `Formula/qkb.rb` in this repo (`depends_on "node"`, installs the published npm package). Until a dedicated `homebrew-qkb` tap exists, install it directly from the repo:

```bash
brew install --formula https://raw.githubusercontent.com/miguelarios/qkb/main/Formula/qkb.rb
```

## The Short Version

Every note with a frontmatter `id` is indexed. An ingestion pipeline walks the vault, chunks markdown with structure-aware break-point scoring, embeds in-process (`node-llama-cpp`/GGUF by default; Ollama or an OpenAI-compatible endpoint optional), and stores everything in a single SQLite file. A search engine layers BM25 (document-level, weighted columns), vector similarity (chunk-level), and Reciprocal Rank Fusion on top, with optional local reranking and query expansion — exposed as `qkb search` / `vsearch` / `query`, `qkb get <UUID>`, and `qkb mcp`.

Inspired by [QMD](https://github.com/tobi/qmd)'s search architecture and its GPU-fast native-binary distribution model, adapted for structured knowledge systems with frontmatter metadata.

## Documents

- [PRD](docs/PRD.md) — what we're building and why
- [Technical Design](docs/DESIGN.md) — architecture, schema, search algorithms
- [Architecture Decision Records](docs/adr/architecture-decisions.md) — the decision log
- [Roadmap](https://github.com/miguelarios/qkb/issues/19) — GitHub issues (label `mvp`)
- [Implementation Plans](docs/plans/) — completed build plans, kept for history

## Migrating from the Python version

The original Python implementation (`qkb-search`, PyPI, `v0.3.0`) is **superseded by this npm package** and no longer lives in this repo (its last copy is under `legacy/python/` at tag `v0.4.3`). It remains installable from PyPI, but no further Python releases are planned. Both share the same `~/.config/qkb/config.toml`, `~/.local/share/qkb/qkb.db`, and `~/.cache/qkb/models` paths, but switching between them (or between embedding providers) changes the vectors, so run `qkb embed --full` after switching.

## Development

```bash
npm ci
npm test          # vitest, offline (FakeProvider — no Ollama/OpenAI/model download)
npm run typecheck # tsc --noEmit
npm run lint       # biome check
npm run build       # tsc -p tsconfig.build.json -> dist/
npm run golden-queries -- ~/.config/qkb/golden_queries.yaml   # acceptance harness (needs a real index)
```

`npm run golden-queries` scores each query in the YAML file against the hybrid top-3 (PRD target: ≥80%); see [`scripts/golden-queries.example.yaml`](scripts/golden-queries.example.yaml) for the schema. Your real golden-queries file is personal vault data and must never be committed to this repo.

## Releasing

Release on merge. A release is a PR titled **`chore(release): X.Y.Z`** that
bumps the version (`npm version X.Y.Z --no-git-tag-version` updates
`package.json` and `package-lock.json`) and adds a `## X.Y.Z (YYYY-MM-DD)`
section to `CHANGELOG.md`. When it merges, `.github/workflows/release.yml`
sees the version change on `main`, runs the checks, publishes to npm
(trusted publishing, with provenance), waits until npm serves the version,
then creates the `vX.Y.Z` tag and a GitHub Release whose notes are that
CHANGELOG section. No local tag push needed. Pushing a matching `v*` tag
by hand still works as a fallback.

After a release, bump `Formula/qkb.rb` to the new tarball and checksum (see the
comment at the top of that file).

## License

MIT
