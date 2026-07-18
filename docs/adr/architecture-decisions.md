# QKB Architecture Decisions

Captures design questions raised during brainstorming, the options considered, and the decisions made with rationale.

---

## ADR-001: Project Naming

**Date**: 2026-04-02
**Status**: Decided

**Question**: What should the project be called?

**Options considered**:
- `pis-search` — tied to PIS (Personal Information System), a term not widely recognized
- `qkb` — Query Knowledge Base, mirrors QMD's naming pattern (Query Markdown Documents)
- `pkb-search`, `vault-search`, and other alternatives

**Decision**: `qkb` (Query Knowledge Base)

**Rationale**: Short, memorable, parallel to QMD's naming convention. "Knowledge base" is the widely recognized term for what the Obsidian vault represents (per PKM/PKMS/PIM/PIS research). The name describes what it does (query) and what it searches (a knowledge base) without being tied to a specific tool name like Obsidian.

---

## ADR-002: Obsidian URI Strategy

**Date**: 2026-04-02
**Status**: Decided

**Question**: Should Obsidian URIs use the Advanced URI plugin (`obsidian://adv-uri?vault=...&uid=...`) or standard Obsidian URIs (`obsidian://open?vault=...&file=...`)?

**Options considered**:
- **Advanced URI plugin**: UUID-based, survives file moves, but creates a hard dependency on a third-party plugin
- **Standard Obsidian URI**: Path-based (`obsidian://open?vault=<name>&file=<path>`), no plugin dependency, but goes stale if file moves between ingestion runs

**Decision**: Standard Obsidian URIs, constructed at query time from the current file path.

**Rationale**: No third-party plugin dependency. The URI is ephemeral by nature — it's built on-the-fly from whatever path the database currently has. If a file moves between ingestion runs, the URI may go stale, but the UUID remains the stable identifier in the database. The next ingestion run updates the path, and the URI self-heals. This is an acceptable tradeoff for zero plugin dependencies.

---

## ADR-003: UUID Generation

**Date**: 2026-04-02
**Status**: Decided

**Question**: How should the `id` (UUID) property in frontmatter be generated?

**Options considered**:
- **Advanced URI plugin**: Previously used, but creates plugin dependency
- **Any UUID plugin, QuickAdd macro, or scripting**: Multiple paths to the same result

**Decision**: UUID generation is not prescribed — any method that produces a UUID v4 in the `id` frontmatter property works (plugin, macro, script, manual).

**Rationale**: The ingestion pipeline only cares that `id` exists and contains a valid UUID. How it got there is irrelevant. This avoids coupling the system to any specific Obsidian plugin.

---

## ADR-004: Vault Path Configuration

**Date**: 2026-04-02
**Status**: Decided

**Question**: Should the vault path be hardcoded or configurable?

**Decision**: Environment variable (`VAULT_PATH`), with a sensible default.

**Rationale**: QKB runs in multiple environments (macOS local, Docker on a home server). Hardcoding a path doesn't work. An env var is the simplest configuration mechanism that works everywhere.

---

## ADR-005: BM25 Granularity — Document-Level vs Chunk-Level

**Date**: 2026-04-03
**Status**: Decided

**Question**: Should BM25 (FTS5) operate at the document level (one row per document with weighted metadata columns) or at the chunk level (one row per chunk)?

**Context**: This is a fundamental architectural decision that affects the FTS5 schema, how RRF fusion works, and what kind of results BM25 returns.

**Options considered**:

1. **Document-level BM25 with weighted columns** (QMD's approach)
   - FTS5 table has columns: title, tags, context, body, type — each with tunable BM25 weights
   - Returns ranked documents; vector search returns ranked chunks deduplicated to documents; RRF merges both document-level lists
   - Pros: Title/metadata get explicit weight control, IDF signal is cleaner at document level, simpler schema, proven in QMD
   - Cons: Loses passage-level precision in the BM25 path (vector search provides that instead)

2. **Chunk-level BM25** (standard RAG pattern)
   - FTS5 table has one row per chunk, `chunk_text` only
   - Both BM25 and vector operate at the same granularity — clean RRF merge
   - Pros: Same granularity for both backends, standard in the RAG literature
   - Cons: Chunks lose document context (title, metadata), no way to weight title matches vs body matches

3. **Chunk-level BM25 with metadata prefix** (Anthropic's Contextual Retrieval variation)
   - Prepend frontmatter metadata or LLM-generated summary to each chunk before FTS5 indexing
   - Anthropic's research shows 49% reduction in retrieval failures (67% with reranking)
   - Pros: Research-backed, same granularity as vector, context preserved
   - Cons: LLM-generated summaries add ingestion cost; metadata-only prefix is just keywords, not a real summary; loses fine-grained weight control per field

**Decision**: Document-level BM25 with weighted columns (Option 1).

**Rationale**:
- **QKB serves dual audiences**: LLM agents need passage-level context (vector search handles this), but human users want to find the right *document* to open in Obsidian. Document-level BM25 directly serves the human use case.
- **Rich metadata deserves explicit weighting**: QKB has richer metadata than QMD (title, context, tags, type). A title match for "project kickoff" should rank very differently from a body mention. Weighted columns make this tunable.
- **Validated by QMD**: QMD uses this architecture in production with the same tech stack (SQLite FTS5 + sqlite-vec, RRF fusion). The different-granularity merge works.
- **Complementary, not competing**: LLM-generated chunk summaries (Anthropic's approach) could enhance the *vector search* path in the future without disrupting document-level BM25. The two approaches layer well.
- **Full body in FTS5 is fine**: FTS5 handles large documents well with built-in length normalization. Even long transcripts don't need truncation.

**FTS5 schema**:
```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  tags,
  context,
  body,
  type,
  tokenize='porter unicode61'
);

-- Query with weights: title 5.0, tags 3.0, context 2.0, body 1.0, type 0.5
ORDER BY bm25(documents_fts, 5.0, 3.0, 2.0, 1.0, 0.5)
```

**Research backing**: See `references/bm25-architecture-research.md` for full analysis of the RAG literature, Anthropic's Contextual Retrieval, and QMD's approach.

---

## ADR-006: Extra Frontmatter Properties Storage

**Date**: 2026-04-03
**Status**: Decided

**Question**: Should QKB store frontmatter properties beyond the core contract (id, type, date created, date, context, source, tags)?

**Context**: Obsidian notes may have domain-specific properties like `company`, `interviewer`, `provider`, `salary-min`, `status`, etc. These vary by domain and evolve over time.

**Options considered**:

1. **Strict core only** — Only ingest contract fields. Domain properties exist in the markdown body only, findable via text search but not as structured filters.
2. **Core columns + metadata key-value table** — Core fields get dedicated indexed columns. Everything else in frontmatter gets stored in a key-value table (`document_id`, `key`, `value`). Domain properties are queryable but not first-class.
3. **Core columns + curated domain columns** — Hand-pick domain fields and give them dedicated columns. Schema changes every time a new domain is added.

**Decision**: Option 2 — Core columns + metadata key-value table.

**Rationale**: (from Claude Desktop conversation) Core fields used for filtering and joining (`id`, `type`, `context`, `source`, `date`, `file_path`) earn dedicated indexed columns because they appear in SQL WHERE clauses constantly. Everything else goes into a key-value table for occasional filtering. This means QKB never needs a schema change when a new domain is added. The performance difference between indexed columns and key-value lookups is negligible at personal vault scale.

**Schema addition**:
```sql
CREATE TABLE metadata (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    PRIMARY KEY (document_id, key)
);
```

---

## ADR-007: FTS5 Column Weights

**Date**: 2026-04-03
**Status**: Decided

**Question**: What BM25 weights should be assigned to each FTS5 column?

**Decision**:

| Column | Weight | Rationale |
|--------|--------|-----------|
| `title` | 5.0 | Dense signal, short, always relevant — strongest boost |
| `tags` | 3.0 | Human-curated, high precision signal |
| `context` | 2.0 | Topical grouping slug — good for surfacing related notes |
| `body` | 1.0 | Baseline, high volume, noisier |
| `type` | 0.5 | Better as a filter than a ranking signal |

**Rationale**: Weights reflect signal density relative to text volume. Title is short and human-written — a keyword match there is highly intentional. Tags are human-curated labels. Context is a single slug. Body is the bulk of the text. Type is usually better used as a filter (`--type transcript`) than a free-text match. These are tunable once real data is available.

**Note**: `source`, `date`, and `id` are excluded from FTS5 — they're identifiers and timestamps, not text to match against. They remain as metadata columns on the `documents` table for filtering.

---

## ADR-008: Tags Stored in Two Places (Junction Table + FTS5)

**Date**: 2026-04-04
**Status**: Decided

**Question**: Tags need to support both exact AND-match filtering (`--tags medical,gi`) and BM25 relevance boosting. Should they live in one place or two?

**Options considered**:

1. **Junction table only** — Exact filtering works, but tag matches don't contribute to BM25 relevance ranking.
2. **FTS5 column only** — BM25 boosting works, but exact AND-match filtering is impossible because the `porter unicode61` tokenizer stems words and splits hyphens (e.g., `phone-screen` → `phone` + `screen`).
3. **Both** — Junction table for exact structured filtering, FTS5 `tags` column (space-separated) for BM25 weighted matching.

**Decision**: Option 3 — tags in both places.

**Rationale**: Each copy serves a different purpose. The junction table handles `--tags phone-screen` as an exact match. The FTS5 column lets tag terms contribute to BM25 ranking with a 3.0× weight. Since both are written at ingestion time from the same frontmatter source, they can't drift out of sync.

**Pitfalls evaluated**:
- **FTS5 tokenization mangles hyphenated tags**: `phone-screen` becomes two tokens. This is acceptable for *relevance boosting* (you want partial matches to contribute to ranking) but is exactly why the junction table is needed for *exact filtering*.
- **Tag-heavy documents get a slight BM25 boost**: More tags = more text in the column. BM25 length normalization mitigates this, and at 1-3 tags per note it's negligible.
- **Storage duplication**: Tags are tiny strings. The overhead is bytes, not megabytes.

---

## ADR-009: Context Labels + Description Registry

**Date**: 2026-07-06
**Status**: Decided

**Question**: Does `context` have to be a slug? And should qkb adopt QMD's context-description feature?

**Options considered**:

1. **Strict slugs** — enforce hyphenated lowercase. Predictable, but hostile to quick entry, and real vault data already contains `laundry tips`.
2. **Free-form prose** — maximally easy to enter, but destroys exact-match filtering and pollutes the FTS context column.
3. **Short labels, normalized at ingest, plus a separate description registry** — labels stay filter-keys (trimmed, lowercased, case-insensitive matching); free text lives in an optional per-label description returned with search results.

**Decision**: Option 3.

**Rationale**: The filter never needed sluginess — it needs consistency, which normalization plus a `qkb contexts` listing command provides. Reading the QMD source settled the second half: QMD's context descriptions are *not* used in embeddings, expansion, or reranking — they are attached to results (prepended as `<!-- Context: ... -->` in MCP document text) purely so the consuming LLM picks documents better. That feature is orthogonal to filtering and cheap (one table, one command, attach-at-format-time), so qkb adopts both halves: normalized labels for grouping/filtering, descriptions for agent orientation.

---

## ADR-010: Default Embedding Model — embeddinggemma

**Date**: 2026-07-06
**Status**: Decided

**Question**: Which Ollama embedding model should be the default, given deployment targets of a CPU-only Linux server (Ryzen 3900X) and a GPU macOS machine, and a partly multilingual (Spanish) vault?

**Options considered**:

| Model | Dims | Size | CPU fit | Languages |
|---|---|---|---|---|
| `nomic-embed-text` | 768 | ~140M | Fastest | English-focused |
| `embeddinggemma` | 768 | 300M | Fine | 100+ |
| `qwen3-embedding:0.6b` | 1024 | 600M | Acceptable (batch) | Strongest multilingual |

**Decision**: `embeddinggemma` (768 dimensions).

**Rationale**: Multilingual coverage matters for this vault; embeddinggemma delivers it at a size that ingests a ~3k-note vault in minutes on the CPU-only box. It is also QMD's default, so quality expectations carry over. The `embedding_config` model check makes later switching a cheap, explicit full re-embed rather than a trap.

---

## ADR-011: User-Configurable Frontmatter Mapping

**Date**: 2026-07-06
**Status**: Decided

**Question**: Should the frontmatter contract keys (`id`, `context`, `created`, …) be hardcoded?

**Decision**: No — every key is remappable in `~/.config/qkb/config.toml` under `[frontmatter]`, with the documented contract as strong defaults. A key may map to a list of aliases (first present wins), which also absorbs vault history drift (e.g., `created` vs legacy `date created`).

**Rationale**: qkb is published publicly; no two vaults share conventions. Survey of the author's own vault found the original design's assumed key (`date created`, `YYYY-MM-DD`) was wrong for 97% of notes (`created`, ISO 8601 datetime) — if the reference vault drifts from the spec, everyone's will. The pipeline speaks canonical names internally; mapping is applied once at parse time.

---

## ADR-012: Local (In-Process) Embedding Provider

**Date**: 2026-07-16
**Status**: Decided

**Question**: Ollama requires a resident service; on a laptop used for occasional searches that's an unwanted always-on dependency. Rewrite in a compiled language for a single binary, or add an in-process provider?

**Options considered**:

1. **Status quo, Ollama only.**
2. **Rewrite in Go/Rust/Bun for a true single binary** (what QMD does via node-llama-cpp + Bun compile).
3. **Add a llama-cpp-python provider behind the existing `EmbeddingProvider` protocol as an optional extra.**

**Decision**: Option 3 — add a llama-cpp-python provider behind the existing `EmbeddingProvider` protocol as an optional extra (`qkb-search[local]`), a single module (`qkb.embed.local`). Same GGUF QMD uses (embeddinggemma-300M-Q8_0 from ggml-org), auto-downloaded to `~/.cache/qkb/models/`. Per-machine config: `provider = "local"` on the laptop, `provider = "ollama"` where a container already runs. `model_name` reports the GGUF stem so provider switches force a `--full` re-embed (cross-runtime/quantization vectors are not interchangeable).

**Rationale**: The Ollama dependency is an architecture choice, not a language artifact — the protocol seam already exists, so in-process inference preserves the tested Phase 1 core without the full-rewrite cost of Option 2. Trade-offs accepted: ~1s model load per one-shot CLI call (MCP server loads once); llama-cpp-python compiles from source at install; not a literal single binary (`uv tool install` is the distribution answer).

---

## ADR-013: Default In-Process Provider via fastembed/ONNX (supersedes ADR-010, revises ADR-012)

**Date**: 2026-07-18
**Status**: Decided

**Question**: The default must "just work" on a Mac with a single install — no separate service and no local compile. ADR-012's llama-cpp-python path fails this: llama-cpp-python publishes **no PyPI wheels**, so `uv tool install qkb-search` would compile it from source (CMake + C++ toolchain, minutes, fragile). Ollama (ADR-010's default) installs trivially but requires an always-on service. What should the default in-process backend be?

**Options considered**:

1. **Keep Ollama default.** Lightest install, but the always-on service is exactly the friction we want gone on a laptop.
2. **Promote llama-cpp-python to a core dependency.** No PyPI wheels → every install (and CI) compiles from source; the prebuilt-wheel index can't be pinned from package metadata (PyPI rejects direct index refs). Rejected.
3. **Switch the in-process backend to fastembed (ONNX Runtime).** onnxruntime ships prebuilt platform wheels on PyPI and fastembed is a pure-Python wheel, so `uv tool install qkb-search` installs a working provider with no service and no compile. Multilingual models available.

**Decision**: Option 3. fastembed becomes a **core dependency**, and `provider = "local"` maps to a new `qkb.embed.fastembed.FastEmbedProvider` (in-process ONNX, lazily loaded). The default model **stays embeddinggemma-300M** — the ONNX export (`onnx-community/embeddinggemma-300m-ONNX`, ungated, q8-quantized ~310 MB, 768-dim), registered via fastembed's `add_custom_model` since it's outside the built-in catalog, using the same prompt templates (`qkb.embed.templates`) as the other providers. Ollama stays an optional provider (`provider = "ollama"`). The llama-cpp-python/GGUF path from ADR-012 is retained but demoted to an optional provider (`provider = "gguf"`, the `[gguf]` extra) — kept for anyone who wants a specific GGUF, forced on no one. `model_name` reports the HF model id, so a provider/model switch forces a `--full` re-embed.

**Rationale**: The requirement is "the work is done upfront so the user just installs" — which in Python means **wheels** (onnxruntime's C/C++ compiled once by its builders), exactly analogous to QMD's prebuilt node-llama-cpp native binaries (QMD is an npm package bundling prebuilt natives, not a Bun binary — corrected here). llama-cpp-python breaks that on PyPI; fastembed/onnxruntime honor it with zero wheel-building burden on us. Crucially, the runtime choice does **not** constrain the model choice: GGUF and ONNX are packagings of the same weights, and the same embeddinggemma QMD runs through llama.cpp is published (ungated) as ONNX — so qkb keeps ADR-010's model while changing only the engine. An interim draft of this ADR swapped in fastembed's cataloged MiniLM-L12-v2 (384-dim); rejected, since it silently traded model quality for packaging convenience when no trade was necessary (smoke-tested: gemma-ONNX q8, dim 768, normalized, query→doc cosine 0.72 vs 0.32 off-topic). Supersedes ADR-010's *delivery* (same model, ONNX packaging, no Ollama) and revises ADR-012 (the in-process default is now fastembed; llama-cpp is the optional `gguf` provider).
