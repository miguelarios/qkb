# qkb TypeScript Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to
> implement this plan task-by-task (fresh implementer per task, task-review after each, broad
> final review). Steps use checkbox (`- [ ]`) syntax for tracking.

## 0. Why this rewrite

The Python `qkb-search` (v0.3.0, on PyPI, scores 9/10 on golden queries) works, but its **embedding
distribution on Apple Silicon is the pain point**: onnxruntime runs the model on **CPU only** (a
full re-embed of a ~3k-note vault takes ~4 hours), because onnxruntime's CoreML path fragments the
graph and llama-cpp-python has no prebuilt Metal wheels (compiles from source).

Measured on the target Mac (M3), same model (embeddinggemma-300M-Q8_0), fresh compute:

| Engine | Backend | Throughput | Full re-embed (~11k chunks) |
|---|---|---|---|
| llama.cpp | **Metal (GPU)** | 21–38 chunks/s | **~9 min** |
| onnxruntime | CPU | 0.7–6 chunks/s | ~4 hours |

`node-llama-cpp` ships **prebuilt Metal binaries that auto-download on `npm install`** (no user
compile) and does embeddings in-process. So a TypeScript/Node rewrite on `node-llama-cpp` gets
GPU-fast embedding with QMD's one-command install UX, while keeping qkb's differentiator:
**frontmatter → structured, filterable SQLite metadata** (context/source/tags/type/date), which QMD
does not have.

**This is a port, not a reinvention.** The Python source (kept in-repo as legacy — see Task 1)
is the authoritative behavioral spec. Every task references `src/qkb/<module>.py` +
`tests/test_<module>.py` and preserves exact parameters, schema, and algorithms. Parity is the bar.

## 1. Goal & parity checklist

Ship `@miguelarios/qkb` (command `qkb`) on npm (+ Homebrew), feature-equivalent to Python v0.3.0
**plus** multi-provider embeddings. Must preserve, verbatim in behavior:

- [ ] Two-phase indexing: `qkb ingest` (structural, fast, no model) → `qkb embed` (vectors, resumable)
- [ ] Commands: `ingest`, `embed`, `search`, `vsearch`, `query`, `get`, `contexts`, `context describe`, `status`, `mcp`
- [ ] Hybrid search: BM25 (document-level, weighted FTS5 columns) + vector (sqlite-vec, chunk-level) + RRF fusion
- [ ] Filters: `--context --source --type --tags --date-from --date-to --limit`; output `--json`/`--files`
- [ ] Siblings (shared `source` surfaced without a 2nd query); context descriptions; Obsidian URIs
- [ ] Frontmatter opt-in (`context` and/or `source`) + required `id` + parseable date; lenient dates; alias mapping; context normalization
- [ ] Structure-aware chunker (break-point scoring; target tokens; overlap)
- [ ] Incremental ingest (content-hash skip), metadata-only refresh, deletion sweep + parse-failure protection, duplicate-id handling, clean skip reporting
- [ ] Resumable embed (per-batch commit; model/dim guard requiring `--full`); `embedding_config`; in-progress sentinel semantics
- [ ] MCP stdio server exposing search/get tools
- [ ] `qkb status`: config/vault/db, provider+model+dim, index counts, pending vectors, "built with" + mismatch warning

**New in the rewrite:**

- [ ] Embedding providers: `llama` (node-llama-cpp GGUF+Metal, **default**), `ollama` (HTTP), `openai` (OpenAI-compatible `/v1/embeddings`), `fake` (tests)
- [ ] Prebuilt-native install (no compile), GPU-accelerated on Apple Silicon / CUDA / Vulkan

**Non-goals (unchanged from Python):** LLM re-ranking, query expansion, HTTP API, attachment
extraction — Phase 2+. Keep the provider/protocol seams so they can be added later (QMD's reranker
and query-expansion models are the eventual target).

## 2. Architecture decisions (verified)

Stack facts were verified against official docs (see Task 0 research; sources in commit trailer of
the research). The non-obvious calls:

- **Runtime: Node (not Bun).** node-llama-cpp + better-sqlite3 are native modules; Bun has
  native-addon ABI friction (QMD ships a Node-vs-Bun runtime shim to dodge it). Node is lower-risk.
- **SQLite: `better-sqlite3` (not `bun:sqlite`/`node:sqlite`).** On macOS `bun:sqlite`/`node:sqlite`
  use Apple's system SQLite, built with `SQLITE_OMIT_LOAD_EXTENSION`, so `sqlite-vec` **cannot load**
  (QMD bug #184). `better-sqlite3` bundles its own SQLite with FTS5 **and** extension loading.
- **Embeddings: `node-llama-cpp` v3** (`createEmbeddingContext()` → `getEmbeddingFor(text)` →
  `.vector`). Prebuilt Metal/CUDA/Vulkan auto-download; falls back to source build only if no
  prebuilt matches (`NODE_LLAMA_CPP_SKIP_DOWNLOAD` to control). ESM-only.
- **Distribution: plain `npm i -g` (like QMD), NOT a compiled single binary.** With native `.node` +
  `.dylib` sidecars, `bun build --compile` can't make a self-contained file. `npm i -g` +
  auto-downloaded prebuilt natives = one command, no compile, GPU-fast. Homebrew via a formula that
  `depends_on "node"` and installs the npm package.
- **MCP: `@modelcontextprotocol/sdk`** (official TS SDK; `McpServer` + `StdioServerTransport`).
- **Frontmatter: `gray-matter`** (handles fenced code blocks containing frontmatter examples).
- **Config: TOML** (`smol-toml`), **same keys/paths/env vars as Python** (`~/.config/qkb/config.toml`,
  `~/.local/share/qkb/qkb.db`, `QKB_*`) so the owner's existing config is reused unchanged.
- **Repo: same repo.** Python moves under `legacy/python/` (kept importable/runnable, tag `v0.3.0`
  stays on PyPI). TS becomes the new tree at repo root. Package: `@miguelarios/qkb`.

## 3. Global constraints

- **Public repo. No PII** in code/tests/fixtures/docs/commits. Synthetic values only (Alice Smith,
  example.com, `homelab-traefik`-style contexts). The gitleaks pre-commit hook + CI enforce it.
- **Vault is read-only.** Never write into it.
- **Unit tests pass offline** with the `fake` provider — no model download, no Ollama, no network.
  Anything needing a real model/Ollama/network is an integration test, excluded from CI.
- **TDD**: each task writes failing tests first (RED), then implements (GREEN), then commits.
- **Do not publish to npm** except from a `v*` tag via the release workflow (owner-only, mirrors the
  PyPI rule). CI must never `npm publish`.
- **Behavioral parity is the spec.** When in doubt, read the Python module + its tests and match
  outputs exactly (schema, weights, tie-breaks, error messages' intent).

## 4. Repo & file structure

```
qkb/
  legacy/python/            # the entire current Python project, moved here (git mv), still runnable
  package.json              # name @miguelarios/qkb, bin { qkb: ./dist/cli.js }, type: module
  tsconfig.json             # NodeNext, strict, ES2022
  biome.json                # lint+format (or eslint+prettier)
  vitest.config.ts
  src/
    cli.ts                  # commander/clack entry; subcommands; progress; --json/--files
    config.ts               # load TOML + env; Config type; defaults
    db/
      schema.ts             # DDL, connect(), sqlite-vec load, vector-table (re)build, dim read
      storage.ts            # Storage class: upsert, pendingChunks, writeVectors, hashes, embedding_config, sentinel, contexts, stats
    embed/
      provider.ts           # EmbeddingProvider interface + getProvider(config)
      fake.ts               # deterministic FakeProvider (tests)
      llama.ts              # LlamaProvider (node-llama-cpp; lazy load; GPU)
      ollama.ts             # OllamaProvider (HTTP /api/embed)
      openai.ts             # OpenAIProvider (/v1/embeddings; base URL + key config)
      templates.ts          # per-model doc/query prompt templates
      models.ts             # GGUF resolve/download to ~/.cache/qkb/models (for llama provider)
    ingest/
      parser.ts             # gray-matter; opt-in rules; lenient dates; alias map; normalizeContext
      chunker.ts            # structure-aware chunking
      pipeline.ts           # ingestVault (structural) + embedPending (resumable)
    search/
      filters.ts            # Filters type + SQL builders
      bm25.ts               # weighted FTS5 document search
      vector.ts             # sqlite-vec KNN, chunk→doc dedup
      hybrid.ts             # RRF fusion + tier orchestration
      hydrate.ts            # siblings, context descriptions, URIs, result shape
      service.ts            # executeSearch(tier, ...)
    server/mcp.ts           # stdio MCP server (tools)
    types.ts                # ParsedNote, Chunk, Document, SearchResult, IngestStats, ...
  test/                     # vitest, one file per module, ported from tests/test_*.py
  scripts/golden-queries.ts # acceptance harness (reads ~/.config/qkb/golden_queries.yaml)
  .github/workflows/{ci.yml,release.yml,gitleaks.yml}
  Formula/qkb.rb            # Homebrew formula (or a tap repo)
  README.md  docs/          # ported/updated
```

## 5. Data model (port verbatim from Python `src/qkb/db.py`)

Same schema, same names — the golden-query tuning depends on it. Tables: `documents`
(id, type, title, context, source, effective_date, created_at, file_path, content_hash, vault_name),
`documents_fts` (FTS5: title, tags, context, body, type; `tokenize='porter unicode61'`),
`chunks` (id INTEGER PK, document_id, chunk_index, chunk_text, chunk_source, token_count),
`chunks_vec` (vec0 virtual table: chunk_id, embedding float[dim]), `tags` (document_id, tag),
`metadata` (document_id, key, value) — includes the `__qkb_meta_hash__` sentinel row,
`context_descriptions` (context, description), `embedding_config` (key, value KV — `model_name`,
`embedding_dim`, `ingest_in_progress`). **Copy the exact DDL** from `db.py`; only the driver changes
(`better-sqlite3`). Load sqlite-vec with `sqliteVec.load(db)` immediately after `new Database(...)`
and before creating `chunks_vec`.

## 6. Config surface (port from `src/qkb/config.py`)

Same TOML sections/keys, same `QKB_*` env overrides, same defaults, same `~`-expansion. Notable
default change: `embedding_provider = "llama"` (was `"local"`/onnx), `embedding_model` =
the GGUF the `llama` provider loads (embeddinggemma-300M-Q8_0), `embedding_dim = 768`. Keep
`ollama_host`, add `openai_base_url` / `openai_api_key` (key via env only, never written), keep
`local_gguf_repo`/`local_gguf_file`/`model_cache_dir`, chunk + search tuning
(`fts_weights=[5,3,2,1,0.5]`, `rrf_k=60`, `vec_candidates=30`, `fts_candidates=30`,
`default_limit=10`), and the frontmatter alias map. Env `QKB_CONFIG`, `QKB_VAULT_PATH`, etc.

## 7. Embedding providers

`interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]>; embedQuery(q: string):
Promise<number[]>; readonly dimension: number; readonly modelName: string; close?(): void }`.

- **`fake`** — deterministic hash→vector (port `embed/fake.py`; `modelName = "fake-<dim>d"`). No I/O.
- **`llama`** (default) — lazy: on first embed, resolve/download the GGUF to `~/.cache/qkb/models`
  (port `embed/models.py`), `getLlama()` → `loadModel({modelPath, gpuLayers: -1 /* Metal */})` →
  `createEmbeddingContext()`; `getEmbeddingFor(text)` per text (batch by awaiting in sequence or
  small concurrency); `.vector` → `number[]`. `modelName` = GGUF stem (forces `--full` re-embed on
  switch, per Python). Apply doc/query templates (`embed/templates.ts`, port `templates.py`).
- **`ollama`** — POST `${host}/api/embed` `{model, input: texts}` → `embeddings`; port dimension
  check + error message from `embed/ollama.py`.
- **`openai`** — POST `${base_url}/v1/embeddings` `{model, input}` with `Authorization: Bearer`;
  supports OpenAI + compatible servers (LM Studio, llamafile, vLLM). Key from `QKB_OPENAI_API_KEY`.
- `getProvider(config)` dispatch on `embedding_provider`; unknown → throw (port `embed/__init__.py`).

## 8. Tasks

Each task: write failing tests first (port the matching `tests/test_*.py` cases + add stack-specific
ones), implement, run tests, commit. Reference the cited Python module for exact behavior.

### Model selection (REQUIRED — pass these explicitly)

Per `superpowers:subagent-driven-development`, **the controller MUST pass the model explicitly on
every implementer and reviewer dispatch** — an omitted model silently inherits the session's model
(usually the most expensive). Use the table below. Rationale (from the skill): mechanical
transcription with a complete spec + ported tests → cheapest tier (`haiku`); native/library
integration and multi-file coordination → standard tier (`sonnet`); subtle correctness that governs
data integrity or the golden-query bar → most capable (`opus`). This plan is mostly "port from
tested Python," so most tasks are `sonnet`, a couple are `haiku`, and the two correctness-critical
ones plus the final review are `opus`.

| Task | Implementer | Reviewer | Why |
|---|---|---|---|
| 1 — Scaffolding | `sonnet` | `sonnet` | native-stack setup, CI, `git mv` |
| 2 — Config | `haiku` | `haiku` | mechanical port + ported tests |
| 3 — DB schema + connection | `sonnet` | `sonnet` | better-sqlite3 + sqlite-vec native integration |
| 4 — Frontmatter parser | `sonnet` | `sonnet` | opt-in + lenient-date correctness |
| 5 — Chunker | `sonnet` | `sonnet` | algorithm fidelity |
| 6 — Providers | `sonnet` | `sonnet` | node-llama-cpp + HTTP, multi-file |
| 7 — Storage | `sonnet` | `sonnet` | many methods, transactions |
| **8 — Ingest pipeline (structural)** | **`opus`** | **`opus`** | deletion-sweep / parse-failure protection — subtle data-loss correctness |
| 9 — Embed pipeline (resumable) | `sonnet` | `sonnet` | resume + model/dim guard |
| 10 — Filters | `haiku` | `haiku` | mechanical SQL port |
| 11 — BM25 search | `sonnet` | `sonnet` | ranking affects golden queries |
| 12 — Vector search | `sonnet` | `sonnet` | sqlite-vec KNN + dedup |
| **13 — Hybrid RRF + tiers** | **`opus`** | **`opus`** | fusion quality = the ≥8/10 bar |
| 14 — Result hydration | `sonnet` | `sonnet` | siblings / URIs / retrieval edge cases |
| 15 — CLI | `sonnet` | `sonnet` | many commands, progress, Ctrl-C |
| 16 — MCP server | `sonnet` | `sonnet` | SDK integration, tool-shape parity |
| 17 — Release + distribution | `sonnet` | `sonnet` | npm OIDC, Homebrew, CI |
| 18 — E2E acceptance | — (manual, owner-run) | — | real vault; not a subagent task |
| **Final whole-branch review** | — | **`opus`** | broad parity + correctness review before tag |

If an implementer escalates (BLOCKED/NEEDS_CONTEXT), bump that task one tier
(`haiku`→`sonnet`→`opus`) and re-dispatch with more context — do not force the same model to retry
unchanged.

- [ ] **Task 1 — Repo restructure + Node/TS scaffolding.** `git mv` the Python project into
  `legacy/python/` (keep it runnable; update the Python CI workflow paths or gate it to that dir).
  Add `package.json` (`@miguelarios/qkb`, `type: module`, `bin`, engines node>=20), `tsconfig`
  (NodeNext/strict), `vitest`, `biome`, a `src/cli.ts` stub printing `--version`, and deps:
  `node-llama-cpp better-sqlite3 sqlite-vec @modelcontextprotocol/sdk gray-matter smol-toml commander`
  (+ types). CI: Node matrix (20/22) `npm ci && npm test && biome check && tsc --noEmit`. **Test:**
  `qkb --version` prints package version; a smoke test opens an in-memory better-sqlite3 DB and
  `sqliteVec.load` succeeds (proves the native stack installs). Gitleaks config/CI carried over.

- [ ] **Task 2 — Config module** (`src/config.ts`). Port `config.py`: TOML load via `smol-toml`,
  `QKB_*` env overrides, defaults (provider `llama`, dim 768), `~` expansion, alias map. **Tests:**
  port `test_config.py` (defaults, TOML overrides + alias normalization, env-wins-over-TOML, missing
  file → defaults, provider defaults, openai key from env only).

- [ ] **Task 3 — DB schema + connection** (`src/db/schema.ts`). Port `db.py` DDL exactly;
  `connect(dbPath, dim)` → better-sqlite3 + `sqliteVec.load` + create tables + `chunks_vec` at dim;
  `vectorTableDimension(db)` (read from DDL), `rebuildVectorTable(db, dim)`, `placeholders(n)`.
  **Tests:** port `test_db.py` (tables exist; vec table dim readback; rebuild changes dim; a
  round-trip insert+`MATCH` KNN returns a row — proves sqlite-vec works).

- [ ] **Task 4 — Frontmatter parser** (`src/ingest/parser.ts`). Port `parser.py` with `gray-matter`:
  opt-in = `context` and/or `source` present; else return null (opt-out). Opted-in requires `id`
  (else `NoteDataError`) and a parseable date from `created`/`date` aliases (lenient parsing — port
  the exact accepted formats incl. ISO datetime; unparseable Templater placeholders → `NoteDataError`).
  `normalizeContext` (trim+lowercase), alias resolution, tags parsing. **Tests:** port
  `test_parser.py` fully (opt-out, missing id, unparseable date, alias fallback, context normalize,
  fenced-code-block frontmatter not mis-parsed).

- [ ] **Task 5 — Chunker** (`src/ingest/chunker.ts`). Port `chunker.py` structure-aware break-point
  scoring, `chunk_target_tokens`, `chunk_overlap_percent`; return `{index, text, tokenCount, source}[]`.
  Match token counting approach. **Tests:** port `test_chunker.py` (headings/paragraph boundaries
  preferred, overlap, target size, tiny + huge docs).

- [ ] **Task 6 — Providers** (`src/embed/*`). Implement the interface + `fake`, `templates`, `models`
  (GGUF download, port `models.py` atomic `.part`→rename), `llama`, `ollama`, `openai`, and
  `getProvider`. **Tests (offline):** fake determinism + dim; template selection; `getProvider`
  dispatch incl. unknown→throw; `llama`/`ollama`/`openai` unit-tested with an **injected fake client**
  (no real model/HTTP), asserting request shape, template application, dim check, batching. Real
  model/HTTP = integration tests (excluded from CI): `llama` embeds two texts and ranks a relevant
  pair over an off-topic one (mirrors Python's integration test); `ollama`/`openai` behind env guards.

- [ ] **Task 7 — Storage layer** (`src/db/storage.ts`). Port `storage.py`: `upsert(note, chash,
  chunks, embeddings?)` (embeddings optional → chunks without vectors), `pendingChunks()`,
  `writeVectors(rows)` (one tx/batch, resumable), `contentHash`, `metadataHash`, `getContentHash`,
  `allMetadataHashes`, `updateMetadataIfChanged` (no-op fast path), `indexedPaths`, `delete`,
  `clearContentHash`, `checkEmbeddingConfig`/`storedEmbeddingConfig`/`commitEmbeddingConfig`,
  `mark/clear/isIngestInProgress`, `rebuildVectorIndex`, context descriptions, `listContexts`,
  `stats()` (documents, chunks, vectors, dim, contexts, lastIndexedAt). **Tests:** port
  `test_storage.py` (upsert writes all tables; re-upsert replaces not duplicates; delete cascades;
  content/metadata hash roundtrip; metadata-only refresh is a no-op when unchanged; pending/write
  vectors; stored_embedding_config roundtrip; contexts + stats).

- [ ] **Task 8 — Ingestion pipeline (structural)** (`src/ingest/pipeline.ts` → `ingestVault`). Port
  `pipeline.py` `ingest_vault(provider=None)` path: walk `**/*.md` (skip dotdirs), parse, chunk,
  `upsert` **without vectors**; incremental content-hash skip; `updateMetadataIfChanged`; duplicate-id
  handling; deletion sweep with parse-failure protection (`parse_failed_ids`/`unresolved_failures`
  — **port this correctness logic exactly**, it prevents silent search data loss); `onProgress(done,
  total, current)` + `onSkip(path, reason)` (reasons: `no id`, `no date`, `duplicate id`, `parse
  error`); `--full` re-chunks. **Tests:** port the pipeline tests (new/unchanged/updated; opt-out +
  deletion de-index; parse-exception protection; date-unparseable protection; duplicate id; renamed-
  and-failed protection; structural pass leaves 0 vectors + BM25 ready; skip reasons + progress).

- [ ] **Task 9 — Embed pipeline (resumable)** (`src/ingest/pipeline.ts` → `embedPending`). Port the
  0.3.0 `embed_pending`: model/dim guard (mismatch without `--full` throws with the exact remedy
  message), commit config up front (resumable), `--full` rebuilds+re-embeds all, batch (size 64),
  `writeVectors` per batch, `onProgress`. **Tests:** port (structural→embed fills vectors + commits
  config; incremental embeds only new; model change requires `--full`; `--full` re-embeds under new
  model; a mid-batch throw leaves earlier batches committed = resumable).

- [ ] **Task 10 — Filters** (`src/search/filters.ts`). Port `filters.py`: context (normalized,
  case-insensitive), source, type, tags (AND, whole-tag via junction table), date range. **Tests:**
  port `test_filters.py`.

- [ ] **Task 11 — BM25 search** (`src/search/bm25.ts`). Port `bm25.py`: weighted `bm25(documents_fts,
  5,3,2,1,0.5)`, filters applied, candidate cap. **Tests:** port `test_bm25.py` (weights matter;
  filters restrict; ranking).

- [ ] **Task 12 — Vector search** (`src/search/vector.ts`). Port `vector.py`: `chunks_vec ... WHERE
  embedding MATCH ? AND k = ?`, filter pre-restriction by chunk_id set, chunk→document dedup keeping
  best distance, partial-index-safe (works with < all chunks embedded). **Tests:** port
  `test_vector.py` (exact-text ranks first; dedup to documents; filters; long-doc doesn't crowd out;
  k/limit behavior).

- [ ] **Task 13 — Hybrid RRF + tiers** (`src/search/hybrid.ts`, `service.ts`). Port `hybrid.py` +
  `service.py`: RRF fusion (`rrf_k=60`) over document-level BM25 list + deduped vector list; tier
  orchestration (`bm25`|`vector`|`hybrid`); dimension-mismatch handling; limit fallback to config
  default; `--limit` validation (>=1). **Tests:** port `test_hybrid.py` + `test_service.py`
  (RRF merges the two lists; tie-breaks; bm25 tier needs no provider; dimension mismatch doesn't
  block bm25; limit rules).

- [ ] **Task 14 — Result hydration** (`src/search/hydrate.ts`, `retrieval`). Port `results.py` +
  `retrieval.py`: sibling surfacing (shared `source`, no 2nd query), context-description attachment,
  Obsidian URI construction (`obsidian://open?vault=&file=`), matched-text snippet, `get`
  by id/prefix (raw file read from the read-only vault; typed error when file missing/dir/ambiguous).
  **Tests:** port `test_results.py` + `test_retrieval.py` (siblings; URIs; prefix/ambiguous/missing;
  raw utf-8; percent/underscore prefix literalness).

- [ ] **Task 15 — CLI** (`src/cli.ts`). `commander`-based; all commands + flags; rich progress
  (`ora`/`cli-progress`) for ingest/embed with current-file + counts; clean skip summaries (grouped
  by reason, `-v` lists); graceful Ctrl-C (SIGINT → "Aborted … re-run to resume", exit 130);
  `--json`/`--files` emitters; `status` (human default + `--json`, pending-vector line + built-with +
  mismatch warning). **Tests:** port `test_cli.py` (ingest→embed→query json; files+filters; get+
  contexts+status; status shows built-with + mismatch + pending; source/limit filters; clean errors,
  no stack traces) using a CLI runner over the compiled entry with the `fake` provider + a temp vault.

- [ ] **Task 16 — MCP server** (`src/server/mcp.ts`). `@modelcontextprotocol/sdk` `McpServer` +
  `StdioServerTransport`; tools mirroring `query`/`search`/`vsearch`/`get`/`contexts` with the same
  filter args and result shape (port `server/mcp.py`, incl. context-description prepending in
  document text). **Tests:** port `test_mcp.py` (tool list; a query tool returns the expected doc;
  get tool; filters) by driving the server in-process.

- [ ] **Task 17 — Release + distribution.** `release.yml` on `v*` tags: build (`tsc`),
  `npm publish --access public` via npm **Trusted Publishing/OIDC** (no token) + GitHub Release.
  `Formula/qkb.rb` Homebrew formula (`depends_on "node"`, installs the npm tarball, `bin.install`) —
  or a tap repo `homebrew-qkb`; document `brew install`. `ci.yml` Node 20/22 matrix. `gitleaks.yml`
  carried over. Port `scripts/golden-queries.ts` (reads `~/.config/qkb/golden_queries.yaml`, runs
  `query`, scores top-3). README rewrite (install `npm i -g @miguelarios/qkb`; provider table; two-
  phase flow; Apple-Silicon-fast note). **Tests:** workflow YAML lint; `golden-queries` unit-tested
  with the fake provider on synthetic fixtures (real vault is manual acceptance).

- [ ] **Task 18 — End-to-end acceptance (manual, real vault).** On the owner's Mac: `npm i -g` (or
  `npm link`), `qkb ingest` (seconds), `qkb embed` with `provider=llama` (Metal; expect ~10–15 min,
  **not** hours), `qkb status` (768-dim, built-with the GGUF), `qkb query` spot-checks, then
  `scripts/golden-queries.ts` must score **≥8/10 top-3** — matching Python. Also smoke `ollama` and
  `openai` providers behind config. Record the embed wall-clock vs the Python ~4h as the headline.

## 9. Acceptance criteria (unchanged bar, from PRD)

- **Primary:** ≥8/10 golden queries return the target doc in top-3 via **both** CLI and MCP.
- **Secondary:** full ingest no errors; no-change re-ingest < 5 s; keyword < 50 ms, hybrid < 1 s
  (excluding first-call model load); siblings surface without a second query.
- **New headline:** full-vault `qkb embed` on Apple Silicon completes in **minutes, not hours**
  (Metal), with a resumable `embed` (Ctrl-C safe).

## 10. Migration & continuity

- Python stays at `legacy/python/`, tag `v0.3.0` remains installable from PyPI; note in README it's
  superseded by the npm package.
- Reuse `~/.config/qkb/config.toml`, `~/.local/share/qkb/qkb.db`, and
  `~/.cache/qkb/models` paths (owner re-ingests; different embeddings anyway).
- The owner's private `~/.config/qkb/golden_queries.yaml` is read locally, never copied into the repo.

## 11. Risks & mitigations (from stack verification)

1. **macOS sqlite-vec extension loading** — solved by `better-sqlite3` (bundles its own SQLite with
   FTS5 + extension loading). Do **not** use `bun:sqlite`/`node:sqlite`. (Task 3 smoke test guards this.)
2. **Native-addon ABI** — standardize on **Node** (not Bun); pin Node engines; CI on the same majors.
3. **No true single binary** — accept `npm i -g` + prebuilt natives (QMD's model); Homebrew wraps it.
   Don't promise a self-contained file.
4. **node-llama-cpp is ESM-only** — `type: module` throughout; NodeNext resolution.
5. **First-run model download** (~310 MB GGUF via the `llama` provider) — surfaced with a clear
   message + progress; cached under `~/.cache/qkb/models`; `qkb embed` is resumable so a dropped
   download/interruption is recoverable.
6. **Parity drift** — every task ports from the cited Python module + tests; the final review diffs
   behavior against Python on the golden queries before tagging.
```
