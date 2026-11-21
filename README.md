# qkb — Query Knowledge Base

An on-device hybrid search engine for Obsidian vaults that understands YAML frontmatter metadata. Combines BM25 keyword search (SQLite FTS5) and vector semantic search (sqlite-vec) with metadata filtering, sibling-document surfacing, and two first-class interfaces: a CLI for humans and an MCP server for LLM agents.

**Status**: v0.5 on npm — a TypeScript rewrite of the original Python `qkb-search`, with multi-provider embeddings and GPU-accelerated (Metal) local embedding on Apple Silicon. The roadmap lives in GitHub issues; the MVP is tracked in [#19](https://github.com/miguelarios/qkb/issues/19).

## Quickstart

**1. Install** (isolated global CLI):

```bash
npm i -g @miguelarios/qkb
```

Requires Node ≥20. No separate service, no compile step for the default provider — `node-llama-cpp` ships prebuilt native binaries (Metal-accelerated on Apple Silicon) that download automatically on install.

qkb runs under any Node ≥20, not only the one that installed it, so an MCP
client that launches `qkb` with its own bundled Node works without pinning.
Its SQLite addon (`better-sqlite3`) is compiled per Node major; when the
installed build doesn't fit the running Node, qkb fetches the upstream
prebuilt for that Node once into `~/.cache/qkb/native` (override with
`QKB_NATIVE_CACHE_DIR`; `QKB_NATIVE_DOWNLOAD=0` turns the fetch off) and
prints a note to stderr. Upstream publishes prebuilts for Node 22, 24, 25
and 26; on other versions (e.g. Node 20), or offline, qkb exits with a
message naming both Node versions and the `npm rebuild` command that fixes
it. If npm warns that install scripts for `better-sqlite3` were skipped
(npm's `allow-scripts` policy), the same fallback applies.

**2. Point qkb at your vault** — create `~/.config/qkb/config.yaml`
(`qkb init --vault ~/Documents/MyVault` writes a commented starter file there
if none exists):

```yaml
vault:
  path: ~/Documents/MyVault   # your Obsidian vault (read-only to qkb)
  name: MyVault               # used to build obsidian:// links
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

Four interchangeable providers, set via `embedding.provider` in `config.yaml`:

| provider | how it runs | when to use |
|---|---|---|
| `llama` *(default)* | in-process via `node-llama-cpp` (GGUF, Metal-accelerated on Apple Silicon, prebuilt binaries — no compile) | just works, fastest on-device option, especially on Apple Silicon |
| `ollama` | the [Ollama](https://ollama.com) HTTP API | you already run Ollama (e.g. a Linux box or shared server) |
| `openai` | any OpenAI-compatible `/v1/embeddings` endpoint | OpenAI itself, Azure OpenAI, or a local server (LM Studio, vLLM, llamafile) |
| `fake` | deterministic hash-based vectors, no model | tests and CI only |

Switching provider or model changes the vectors, so run `qkb embed --full`
afterward to re-embed everything.

```yaml
# ~/.config/qkb/config.yaml — llama (default)
embedding:
  provider: llama
  model: embeddinggemma-300M-Q8_0
  dimension: 768
  # local_gguf_repo / local_gguf_file / model_cache_dir also configurable — see below
```

```yaml
# ~/.config/qkb/config.yaml — ollama
embedding:
  provider: ollama
  model: embeddinggemma
  dimension: 768
  ollama_host: http://localhost:11434
```

```yaml
# ~/.config/qkb/config.yaml — openai-compatible
embedding:
  provider: openai
  model: text-embedding-3-small
  dimension: 1536
  openai_base_url: https://api.openai.com  # or a local/compatible endpoint
```

The OpenAI API key is read from the `QKB_OPENAI_API_KEY` environment
variable only — it's never stored in `config.yaml`.

## Configuration reference

`~/.config/qkb/config.yaml` (or `config.yml`; all keys optional; shown with their defaults).
`QKB_CONFIG=/path/to/alt-config.yaml` points at a different config file
entirely.

Earlier releases used TOML (`config.toml`). If the config `.yaml` path doesn't
exist but a `.toml` file of the same name sits beside it, that file is read
with a deprecation warning on stderr. The sections and keys are unchanged, so
migrating is a straight syntax conversion; TOML support will be removed in a
future release.

Quote string values that YAML would read as a number: `name: "2024"`, not
`name: 2024` (an unquoted `0755` or `1:30` would even change value). qkb
refuses an unquoted one with an error saying so, and treats an empty value
(`name:`) as unset.

```yaml
vault:
  path: ~/Notes
  name: Notes

database:
  path: ~/.local/share/qkb/qkb.db

embedding:
  provider: llama                                      # llama | ollama | openai | fake
  model: embeddinggemma-300M-Q8_0
  dimension: 768
  ollama_host: http://localhost:11434
  local_gguf_repo: ggml-org/embeddinggemma-300M-GGUF
  local_gguf_file: embeddinggemma-300M-Q8_0.gguf
  model_cache_dir: ~/.cache/qkb/models
  openai_base_url: ""                                  # optional override (empty = unset)
  # doc_template / query_template: optional explicit "{t}"-placeholder prompt
  # templates, overriding the per-model default asymmetric prefixing.

chunking:
  target_tokens: 500
  overlap_percent: 15

search:
  default_limit: 10
  rrf_k: 60
  vec_candidates: 30
  fts_candidates: 30
  fts_weights:              # keyword-ranking weight per field (0 = ignore)
    title: 5.0
    aliases: 5.0
    headings: 3.0
    tags: 3.0
    sibling_fields: 3.0     # declared fields with siblings: true
    fields: 2.0             # other declared frontmatter.fields
    body: 1.0
    type: 0.5

frontmatter:
  # Which property names feed each core field (first present wins). Defaults:
  # id:       [id]
  # type:     [type]
  # title:    [title]             # falls back to the file name
  # aliases:  [aliases, alias]
  # date:     [date]
  # created:  [created, date created]
  # modified: [modified, updated, date modified]
  # tags:     [tags, tag]
  fields:
    # Optional: extra properties to search, embed, return and describe to agents
    # (see "Extra frontmatter properties" below), e.g.:
    # project: Project this note belongs to

mcp:
  host: 127.0.0.1           # HTTP transport only (`qkb mcp --http`)
  port: 8181
  allowed_origins: []       # browser origins allowed besides loopback; ["*"] disables the check

watch:
  interval: 300             # seconds between re-index runs in watch mode

rerank:                     # see "Reranking and query expansion"
  enabled: false
  provider: llama           # llama | fake
  gguf_repo: ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF
  gguf_file: qwen3-reranker-0.6b-q8_0.gguf
  candidates: 30            # top hybrid hits the reranker re-scores

expansion:
  enabled: false
  provider: llama           # llama | fake
  gguf_repo: tobil/qmd-query-expansion-1.7B-gguf
  gguf_file: qmd-query-expansion-1.7B-q4_k_m.gguf
  max_variants: 4
```

Several vaults: replace `vault` with a `vaults` list (see "Multiple vaults" below):

```yaml
vaults:
  - name: Personal
    path: ~/Documents/Personal
  - name: AgentWiki
    path: ~/agent-wiki
    include_by_default: false   # optional: searched only when named or with --all-vaults (default true)
```

### Environment-variable overrides

Only the keys below have a `QKB_*` environment-variable override — `chunking`, `search`, and `frontmatter` keys do **not** (config-file-only). An env var always wins over `config.yaml`.

| `config.yaml` key | env var |
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
| *(no `config.yaml` key — env only)* | `QKB_OPENAI_API_KEY` |
| `mcp.host` | `QKB_MCP_HOST` |
| `mcp.port` | `QKB_MCP_PORT` |
| `mcp.allowed_origins` | `QKB_ALLOWED_ORIGINS` (comma-separated) |
| `watch.interval` | `QKB_WATCH_INTERVAL` |
| `rerank.enabled` | `QKB_RERANK` |
| `rerank.provider` | `QKB_RERANK_PROVIDER` |
| `expansion.enabled` | `QKB_EXPANSION` |
| `expansion.provider` | `QKB_EXPANSION_PROVIDER` |

`QKB_VAULT_PATH` names exactly one vault: when set, it replaces a
configured `vaults` list.

Plus `QKB_CONFIG`, which isn't a per-key override — it points qkb at a
different `config.yaml` path entirely.

`QKB_NATIVE_CACHE_DIR` and `QKB_NATIVE_DOWNLOAD` (env only) control where
qkb keeps a SQLite addon fetched for a Node other than the install-time one,
and whether it may fetch one at all (`0` = no).

## MCP usage

qkb exposes three tools to LLM agents. Clients prefix them with the server's
name, so in Claude Code (`claude mcp add qkb …`) they appear as
`mcp__qkb__search`, `mcp__qkb__get` and `mcp__qkb__status`.

- **`search`** — hybrid BM25 + vector search with the same filters as the CLI (`type`, `tags`, date range, `vaults`, `all_vaults`, `fields`, `limit`), plus optional `rerank` and `expand` (defaults from `rerank.enabled`/`expansion.enabled`). Its description lists your vaults and declared fields, so an agent knows what it can filter on. Each result lists its related notes. Each result also carries `line`, the 1-based line of `file_path` where the match is (the keyword hit, or the first line of the matched passage), so an agent can open `file_path:line` directly; the human CLI output prints the same `path:line` above each `obsidian://` link.
- **`get`** — retrieve a single document by id (or unambiguous id prefix), including every stored frontmatter property and all related notes (`include_related: false` to skip them).
- **`status`** — index health: document/chunk/vector counts, per-vault counts (and whether each is searched by default), declared fields and their most common values (`field_values`), so an agent can build `fields` filters.

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

The HTTP server is stateless (`POST /mcp`) and also serves
`GET /health`. It binds to loopback by default. Requests from a browser page
on another origin are refused unless that origin is listed in
`mcp.allowed_origins` / `QKB_ALLOWED_ORIGINS` (protection against DNS
rebinding). There is no authentication: on a shared network, keep it behind
your firewall or a reverse proxy that adds auth.

Both transports speak MCP protocol revision **2026-07-28**, which has no
`initialize` handshake and no session: each request carries the client's
protocol version and capabilities, so any number of clients share one server
with nothing to track per client. Clients still on a 2025 revision
(2025-11-25 and earlier) are served from the same endpoint; over HTTP they
get no `Mcp-Session-Id` either. A 2026-07-28 response is a JSON body; a
2025-era one is a single-message `text/event-stream`.

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

List several `vaults` (see the configuration reference) and qkb indexes
them into one database. Every result carries its `vault`, `obsidian://`
links use each note's own vault name, and searches can be limited:

```bash
qkb query "deploy checklist" --vault AgentWiki     # repeatable: --vault A --vault B
```

MCP: `{"query": "...", "vaults": ["AgentWiki"]}`. `qkb status` shows counts
per vault.

A vault name must match a configured vault exactly (names are
case-sensitive). An unknown name is an error that lists the configured
names, rather than an empty result.

**Leaving a vault out by default.** Set `include_by_default: false` on a
vault to keep it indexed but out of searches that don't name it. It is still
searched when named (`--vault AgentWiki`, MCP `vaults`), or together with
every other vault with `--all-vaults` (MCP `all_vaults: true`). The MCP
`search` description and `status` say which vaults are left out, so an agent
knows to ask for them. At least one vault must stay included.

Note `id`s are unique across all vaults: the same id in a second vault is
skipped and reported as a duplicate, exactly like a duplicate within one
vault. A note moved from one vault to another is followed (not re-embedded).

## Ranking and related notes

Keyword search weighs where a word appears, not just whether it does: a
match in the title or an alias counts most, then headings and tags, then
declared fields, then body text (`search.fts_weights` tunes each). A note
titled, aliased or headed with your query words beats one that merely
mentions them. Headings inside fenced code blocks are ignored.

Every result lists **related notes**:

- `links_to`: notes it links to with `[[wikilinks]]` (or `![[embeds]]`), in
  the order they appear. A link resolves by file name, vault path, title or
  alias, and one written before its target exists starts resolving once the
  target is indexed;
- `linked_from`: notes that link to it (backlinks);
- `sibling`: notes sharing a value of a *sibling field*, e.g. several clips
  of one web page sharing a `source` (see "Extra frontmatter properties").

Search results show up to 10 related notes each; `qkb get` shows them all
(up to 50 siblings per field).

## Reranking and query expansion

Two optional, local-model stages sit around hybrid search. Both are off by
default, run in-process through `node-llama-cpp` (the models download once
to `model_cache_dir`), and fall back to plain search with a warning if the
model fails.

- **Reranking** (`qkb query --rerank`, MCP `rerank: true`, or `rerank.enabled:
  true`): a cross-encoder (Qwen3-Reranker-0.6B, ~640 MB) reads the
  query with each of the top `candidates` hits (title, declared fields and
  the best-matching passage) and scores the fit. The score is blended with
  the retrieval rank, trusting retrieval more at the top: a confident
  reranker can lift a deep hit, but can't bury an exact title match.
- **Query expansion** (`qkb query --expand`, MCP `expand: true`, or
  `expansion.enabled: true`): a small fine-tuned model (~1.1 GB) rewrites
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

```yaml
frontmatter:
  fields:
    project: Project this note belongs to
    attendees: People present in a meeting
    source: Where a web clip or transcript came from
```

Declared properties are:

- **searchable**: keyword search matches their values (`fts_weights.fields` tunes the weight);
- **embedded**: prepended to each chunk's text as `project: Apollo` lines, so semantic search sees them;
- **returned**: as a `fields` object in `--json`, `qkb get` and MCP results;
- **filterable**: `--field project=Apollo` (repeatable, AND) / MCP `fields: {"project": "Apollo"}`. The match is case-insensitive, and a list property matches any one of its items;
- **described to agents**: each key and its description appear in the MCP `search` tool description and in `status` (with the most common values), so an agent knows what it can filter on. Descriptions are for agents only; the search models read the values.

**Sibling fields.** A property whose shared values group notes (a `source`
shared by clips of one page or a meeting's transcript and notes, an
`author`, a `series`) can be marked `siblings: true`:

```yaml
frontmatter:
  fields:
    source: { description: Where a note came from, siblings: true }
```

Notes sharing a value then list each other as related (`relation:
"sibling"`, with the `field` and `value`), and the values rank like tags
(`fts_weights.sibling_fields`, default 3) instead of like ordinary fields
(2). Pick fields whose values a handful of notes share, not most of the vault.

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

The image `ghcr.io/miguelarios/qkb` serves HTTP MCP on port 8181 and
re-indexes on a timer (`qkb mcp --http --watch`), for `linux/amd64` and
`linux/arm64` (Apple Silicon runs the arm64 image).

```bash
curl -fsSLo compose.yaml https://raw.githubusercontent.com/miguelarios/qkb/main/docker-compose.example.yml
# edit compose.yaml: one `/path/to/Vault:/vaults/Vault:ro` line per vault
docker compose up -d
claude mcp add --transport http qkb http://127.0.0.1:8181/mcp
```

| mount | what it holds |
|---|---|
| `/config` | `config.yaml`, the same file as `~/.config/qkb/config.yaml` |
| `/data` | the index and downloaded models (a named volume) |
| `/vaults/<Name>` | one vault per folder, read-only; qkb never writes to a vault |

**Config.** On first start, with no `/config/config.yaml`, qkb writes a
starter one listing every folder under `/vaults` as a vault named after it
(use the Obsidian vault name, so `obsidian://` links open). Edit it and
`docker compose restart qkb`; it is never overwritten. To bring your own,
put `config.yaml` in `./config` before the first start. Paths in it are
paths inside the container (`/vaults/Notes`), not on the host.
`QKB_SEED_CONFIG=0` turns the starter file off. The `QKB_*` environment
variables still override the file, and a single vault mounted at `/vault`
with `QKB_VAULT_PATH=/vault` keeps working.

**User.** The container starts as root only to make `/config` and `/data`
writable, then runs qkb as `PUID:PGID` (default `1000:1000`). Set them to a
user that can read the vaults (`PUID=0` runs as root). Setting `user:` in
compose skips that step; the mounted directories must then already be
writable by that user. With `cap_drop: [ALL]`, either set `user:` or add back
`CHOWN`, `SETUID` and `SETGID`. Groups added with `group_add` are not kept:
use `PGID`.

**Commands.** `docker compose exec qkb qkb status` (or `ingest`, `embed
--full`, `query …`) runs the CLI against the same index while the server
serves.

### Where the models run

Everything qkb supports outside a container works inside one; what changes
is which hardware the model can use.

| setup | `config.yaml` | model runs on |
|---|---|---|
| In the container *(default)* | `embedding.provider: llama` | the container's CPU. The GGUF model is downloaded to `/data/models` on first start. Works the same on macOS and Linux, with nothing else to run. |
| Ollama on the same machine | `provider: ollama`, `ollama_host: http://host.docker.internal:11434` | whatever Ollama uses: the Apple GPU (Metal) on a Mac, an NVIDIA/AMD GPU on Linux. On Linux, uncomment `extra_hosts` in the compose file. |
| Ollama in the stack | `provider: ollama`, `ollama_host: http://ollama:11434` | an NVIDIA GPU passed to the `ollama` service (`docker compose --profile ollama up -d`, Linux with the NVIDIA Container Toolkit). |
| Ollama or an OpenAI-compatible server elsewhere | `provider: ollama` / `openai` with its URL | that machine. |

- **macOS.** Docker Desktop runs containers in a Linux VM with no access to
  the Apple GPU, so nothing in a container is Metal-accelerated. Use the
  default CPU model, or run Ollama as a normal Mac app and point qkb at it.
  For in-process Metal, run qkb itself on the Mac instead
  (`npm i -g @miguelarios/qkb`, then `qkb mcp --http --watch`): same HTTP
  endpoint, no container.
- **Linux GPU.** The image does not use a GPU for `provider: llama`:
  node-llama-cpp's CUDA builds need the CUDA runtime libraries and are left
  out (about 530 MB), and the image carries no Vulkan drivers. Embed through
  Ollama to use a GPU.
- **Reranking and query expansion** (`rerank.enabled`, `expansion.enabled`)
  only run in-process, so in a container they run on the CPU. They work,
  but each adds a model load and seconds per search.

To build the image yourself: `docker build -t qkb .` and replace `image:`
with `build: .`.

### Obsidian Sync in the stack (optional)

The compose file has an `obsidian-sync` service (profile `sync`) that keeps
`./vaults` in sync with [Obsidian Sync](https://obsidian.md/sync) through
Obsidian's headless client, [`obsidian-headless`](https://obsidian.md/help/sync/headless)
(open beta; needs an Obsidian Sync subscription). qkb mounts the same folder
read-only and indexes whatever arrives on its next re-index pass
(`watch.interval`, default 300 seconds), the same as for any other change.

```bash
mkdir -p vaults/Notes                 # the folder name is the vault name in qkb
docker compose run --rm obsidian-sync ob login
docker compose run --rm obsidian-sync ob sync-list-remote
docker compose run --rm obsidian-sync ob sync-setup --vault "Notes" --path /vaults/Notes
docker compose --profile sync up -d   # and mount ./vaults:/vaults:ro in the qkb service
```

Repeat `sync-setup` for each vault; the service runs `ob sync --continuous`
for every vault that is set up, and restarts if one of them stops. Any other
client command works the same way, e.g.
`docker compose run --rm obsidian-sync ob sync-config --path /vaults/Notes --mode pull-only`.

- The client is Obsidian's proprietary software and is not part of the qkb
  image: the service downloads it from npm into its own volume on first
  start. `OBSIDIAN_HEADLESS_VERSION` pins a version.
- The login and sync state are in the `obsidian-sync-data` volume. Removing
  the volume means logging in and setting up again.
- Back up the vault before the first sync, as Obsidian advises.
- **Creation dates.** On Linux the client cannot set a file's creation time,
  so a note synced down gets "created now" on this machine; its modified time
  is kept. A note first created here uploads with its real creation time.
  But if something here edits a note that was synced down, the client uploads
  that later local creation time, and other devices may take it over. If
  nothing in the container's vault folder needs to write, use
  `--mode pull-only`; if agents add notes there, have them create new notes
  rather than edit synced ones. qkb itself is unaffected: it dates a note
  from its frontmatter, then its modified time, never the creation time.

## Homebrew

A single-file formula lives at `Formula/qkb.rb` in this repo (`depends_on "node"`, installs the published npm package). Until a dedicated `homebrew-qkb` tap exists, install it directly from the repo:

```bash
brew install --formula https://raw.githubusercontent.com/miguelarios/qkb/main/Formula/qkb.rb
```

## The Short Version

Every note with a frontmatter `id` is indexed. An ingestion pipeline walks the vault, chunks markdown with structure-aware break-point scoring, embeds in-process (`node-llama-cpp`/GGUF by default; Ollama or an OpenAI-compatible endpoint optional), and stores everything in a single SQLite file. A search engine layers BM25 (document-level, weighted columns), vector similarity (chunk-level), and Reciprocal Rank Fusion on top, with optional local reranking and query expansion — exposed as `qkb search` / `vsearch` / `query`, `qkb get <UUID>`, and `qkb mcp`.

Inspired by [QMD](https://github.com/tobi/qmd)'s search architecture and its GPU-fast native-binary distribution model, adapted for structured knowledge systems with frontmatter metadata.

## Documents

- [Guide: how qkb reads your notes](docs/GUIDE.md) — properties, declared and sibling fields, related notes, ranking, filters
- [PRD](docs/PRD.md) — what we're building and why
- [Technical Design](docs/DESIGN.md) — architecture, schema, search algorithms
- [Architecture Decision Records](docs/adr/architecture-decisions.md) — the decision log
- [Roadmap](https://github.com/miguelarios/qkb/issues/19) — GitHub issues (label `mvp`)
- [Implementation Plans](docs/plans/) — completed build plans, kept for history

## Migrating from the Python version

The original Python implementation (`qkb-search`, PyPI, `v0.3.0`) is **superseded by this npm package** and no longer lives in this repo (its last copy is under `legacy/python/` at tag `v0.4.3`). It remains installable from PyPI, but no further Python releases are planned. The Python version reads `~/.config/qkb/config.toml`; this package still reads that file as a deprecated fallback but now prefers `~/.config/qkb/config.yaml`. Both share the same `~/.local/share/qkb/qkb.db` and `~/.cache/qkb/models` paths, but switching between them (or between embedding providers) changes the vectors, so run `qkb embed --full` after switching.

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
by hand still works as a fallback. The same run then builds the container
image from that tag and pushes `ghcr.io/miguelarios/qkb:X.Y.Z`, `:X.Y` and
`:latest` (`.github/workflows/docker-publish.yml`; run that workflow by hand
to push an `:edge` image from a branch, or with a version to rebuild that
release's image). A new package on ghcr.io starts private: make it public
once under the package's settings.

After a release, bump `Formula/qkb.rb` to the new tarball and checksum (see the
comment at the top of that file).

## License

MIT
