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
**Status**: Revised by ADR-018 (named weights; aliases and headings columns; context column removed)

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
**Status**: Superseded by ADR-017 (context is an ordinary property; the description registry became `[frontmatter.fields]`, ADR-016)

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

---

## ADR-014: Two-Phase Ingestion — `qkb ingest` (structural) + `qkb embed` (vectors)

**Date**: 2026-07-19
**Status**: Decided

**Question**: `qkb ingest` did everything in one pass — chunk, embed, store. On a real vault (~3k notes / ~11k chunks) embedding a 300M model takes hours, during which the command appears to hang and no search works at all. A smaller model doesn't change the shape of the problem: the fast structural work is held hostage by the slow vector work. (QMD, the reference tool, splits `collection add` from `embed` for exactly this reason.)

**Decision**: Split ingestion into two commands sharing the SQLite index:
- **`qkb ingest`** builds the structural index only — documents, chunks, FTS/BM25 — with no embedding provider loaded (fast, no model download). Chunks are stored without vectors. `--full` re-chunks everything.
- **`qkb embed`** computes vectors for chunks that lack them (`Storage.pending_chunks()`), in committed batches so it is **resumable** — Ctrl-C or a crash keeps completed vectors and a re-run continues. `--full` clears and re-embeds all. The model/dim consistency guard and the `embedding_config` commit move here (they are properties of the vectors), committed up front so an interrupted `--full` resumes rather than restarts.

`ingest_vault(provider=None)` is the structural path; passing a provider keeps the old single-pass inline-embed behavior (used by tests and any caller wanting one shot). Keyword/BM25 search works after `ingest` alone; vector/hybrid search returns whatever is embedded so far and improves as `embed` progresses. `qkb status` surfaces the pending-vector count.

**Rationale**: The expensive part (embedding) and the cheap part (structure + keyword index) have completely different cost and failure profiles, so coupling them made the whole tool as slow and fragile as its slowest component. Decoupling makes the vault searchable in seconds, makes the long embed job interruptible/resumable, and lets embedding run as a separate/background step — while a shared index and the vec0 MATCH query mean partial vector coverage degrades gracefully to keyword-only results rather than failing. Revises the single-pass model implied by ADR-012/ADR-013.

---

## ADR-015: Multiple Vaults Share One Index; Note Ids Stay Globally Unique

**Date**: 2026-09-23
**Status**: Decided

**Question**: The MVP needs several vaults behind one qkb (a personal vault plus an agent-maintained wiki, say), filterable per search (#23). Should a note's identity become `(vault, id)`, or stay `id`?

**Options**:
1. **`(vault, id)` primary key.** Allows the same id in two vaults. But every table keyed by `document_id` (chunks, tags, metadata, FTS `doc_id`, siblings, `qkb get` prefix lookup) would change, existing indexes would need a full rebuild and re-embed, and an id would no longer identify one note.
2. **One database file per vault.** Clean isolation, but cross-vault search then needs query fan-out and merging of BM25/RRF scores across separate indexes.
3. **Globally unique `id`, vault recorded per document.** `documents.vault_name` already exists. A second vault claiming an id is a reported duplicate, the same rule that already applies inside one vault.

**Decision**: Option 3. Paths are unique only per vault, so the path→id map, the parse-failure protection and the deletion sweep are all scoped per vault. The sweep runs only after every vault has been walked, so a note moved between vaults is found and refreshed (metadata only, no re-embed) instead of deleted and re-embedded. Documents from a vault that's no longer configured are swept. `[vault]` stays as shorthand for a one-entry `[[vaults]]` list.

**Rationale**: The `id` property is how the owner defines a note's identity ("that's how we know it's unique"). Two vaults holding the same id are almost always a mirror or a copy, so indexing one and reporting the other matches the existing duplicate rule. No schema migration or re-embed is needed.

---

## ADR-016: Declared Extra Frontmatter Properties

**Date**: 2026-09-23
**Status**: Decided

**Question**: Properties outside the core set (ADR-011) were stored in `metadata` but never read back. How should users make some of them count (#24) without every sync or plugin key polluting ranking and embeddings?

**Decision**: Opt in per key, with a description: `[frontmatter.fields] key = "description"`. Declared values are rendered as `key: value` lines, then:
- stored in `documents.fields_text` and in a new FTS5 `fields` column, placed after the UNINDEXED `doc_id` so the existing bm25() weight positions don't move (weight = optional 6th `fts_weights` entry, default 3.0, like tags);
- prepended to every chunk's embedded text (`embeddingText`), identically on the inline and the two-phase embed paths;
- returned as `fields` in results, filterable (`--field` / MCP `fields`), and listed with their descriptions in the `qkb` tool description and `qkb_status`, so agents learn what the properties mean.

`qkb get` returns every stored property (`metadata`), declared or not.

When a note's rendered fields change (a value edit, or the declared set itself changing), the metadata-refresh path drops only that note's vectors, and the next embed pass recomputes them. This replaces a whole-vault `--full` guard. The metadata hash includes the rendered fields only when they're non-empty, so an index without declared fields keeps its existing hashes and doesn't rewrite every note after the upgrade. Old databases migrate in place: the FTS table is rebuilt from its own stored columns and vectors are kept.

**Alternatives rejected**: indexing every frontmatter key (noisy: sync and plugin keys would affect ranking and vectors); a QMD-style namespaced `qkb:` block (forces owners to duplicate properties they already have).

---

## ADR-017: Every Note With an `id` Is Indexed; `context`/`source` Are Ordinary Properties

**Date**: 2026-09-24
**Status**: Decided (supersedes ADR-009 and the opt-in rule of the original contract)

**Question**: Notes were indexed only if they carried `context` or `source`, plus an `id` and a parseable date. In the owner's vault ~3,000 notes have an `id` but only a few dozen have `context`, so the opt-in rule hid almost everything (#33, #35). What should qualify a note?

**Decision**: The `id` alone. It is the note's identity (unique, stable across renames and vault moves, ADR-015), so it stays required; everything else is optional:
- the date falls back `date` → `created` → `modified` → file mtime, so a note is never rejected for lacking one;
- the title falls back to the file name;
- `context` and `source` lose their dedicated columns and become ordinary stored properties. Declare them in `[frontmatter.fields]` to make them searchable and embedded; filter on them (and any other stored property) with `--field`. `--context`/`--source` remain as deprecated shorthands. Grouping by `source` became opt-in per field (ADR-021).

`qkb ingest` reports how many notes lacked an `id`. The index format changes, so databases carry a schema version (`meta.schema_version`); an older index is dropped and rebuilt empty with a notice to run `qkb ingest && qkb embed`, instead of a hand-written migration. Re-embedding is needed anyway because the embedded text changed.

**Alternatives rejected**: keeping opt-in but switching the trigger to `tags` (arbitrary, and still hides untagged notes); auto-generating ids (writes into a read-only vault).

---

## ADR-018: Title, Aliases and Headings as Ranking Signals; Named FTS Weights

**Date**: 2026-09-24
**Status**: Decided (revises ADR-007)

**Question**: What should BM25 weigh once every note is indexed (#34)?

**Decision**: FTS5 columns `title, aliases, headings, tags, fields, body, type`, weighted `5, 5, 3, 3, 2, 1, 0.5` by default. Aliases are alternative titles (the Obsidian Linter fills them on ~half the owner's notes), so they weigh like the title. ATX headings are short, deliberate summaries of a section, so they weigh like tags; headings inside fenced code are skipped. `[search.fts_weights]` becomes a table keyed by column name (the old positional array is rejected with a message) so adding a column never silently shifts the meaning of a user's weights.

**Rationale**: BM25F-style field weighting is the standard, cheap way to rank "the note about X" above "a note mentioning X". No new moving parts: same FTS5 table, same query.

---

## ADR-019: Related Notes From Wikilinks, Backlinks and Shared Source

**Date**: 2026-09-24
**Status**: Decided

**Question**: Sibling surfacing grouped notes by `source` only (#36). Most notes relate through `[[wikilinks]]`. How should results show related notes?

**Decision**: Ingest stores each note's outgoing link targets (`links` table, in order of appearance; `[[target|alias]]`, `[[target#heading]]` and `![[embeds]]` reduce to the target, fenced code is skipped). Targets are resolved at query time, within the same vault, against file stem, vault path, title and alias, so a link to a note that doesn't exist yet starts resolving when it's indexed and renames need no re-ingest of the linking note. Each result lists `related` notes with a `relation` of `links_to`, `linked_from` or `sibling` (ADR-021); search results cap the list at 10 per result, `qkb get` returns all.

**Alternatives rejected**: resolving links at ingest time (stale on renames and new notes); vector-similarity "more like this" (costly per result, and duplicates what vector search already does).

---

## ADR-020: Optional Local Reranking and Query Expansion

**Date**: 2026-09-24
**Status**: Decided

**Question**: Should qkb add the second-stage mechanisms QMD has (#37, #38), and how, without making search slow or cloud-dependent by default?

**Decision**: Both are optional stages around hybrid search, off by default, enabled per search (`--rerank`/`--expand`, MCP `rerank`/`expand`) or in config (`[rerank]`, `[expansion]`). Both run in-process through node-llama-cpp with the same GGUFs QMD uses (Qwen3-Reranker-0.6B; QMD's fine-tuned 1.7B expansion model with its grammar and sampling settings), loaded lazily and downloaded on first use.
- **Reranking** re-scores the top `candidates` (default 30) hits. Each is shown as title + declared-field lines + one passage (the matching vector chunk, or the chunk sharing most query words when only a BM25 snippet matched). Passages are truncated to the context budget and identical ones scored once. The final score is QMD's position-aware blend `w·(1/rank) + (1−w)·rerank`, with `w` = 0.75 for ranks 1–3, 0.60 for 4–10, 0.40 below, so the reranker can promote deep hits but can't bury a strong retrieval match.
- **Expansion** turns the query into `lex` (→ BM25) and `vec`/`hyde` (→ vector) variants, dropping any that share no word with the query. Each variant adds one RRF list; the original query's two lists weigh 2.
- Either stage failing (model missing, out of memory) logs a warning and returns plain hybrid results.

**Rationale**: Reranking is the largest precision gain available once recall is good; expansion helps short or vague queries. Keeping them optional keeps the default path at one small embedding model and millisecond keyword search, which matters for the watch-mode server on modest hardware. Declared-field descriptions are not fed to either model: they exist for agents choosing filters (self-query), while the reranker reads the field values themselves.

---

## ADR-021: Sibling Fields Are Declared, Not Hard-Coded to `source`

**Date**: 2026-09-24
**Status**: Decided (amends ADR-019)

**Question**: Related notes by shared value read only `source`. Once `source` became an ordinary property (ADR-017), why should that one name be special? Other properties group notes the same way: `author`, `series`, a meeting id.

**Decision**: Any declared field can be a sibling field: `[frontmatter.fields] source = { description = "...", siblings = true }`. The plain string form stays for ordinary fields. For a sibling field:
- notes sharing a value are related (`relation: "sibling"`, with `field` and `value`), after links and backlinks, in declaration order, most recent first. Values match case-insensitively; a list value relates notes sharing any item. `qkb get` lists up to 50 per field;
- its rendered values go to a separate FTS column `sibling_fields`, weighted 3 (like tags) instead of the ordinary `fields` column's 2: a shared value names what a group of notes is about.

No field is a sibling field by default. Which fields are sibling fields is part of the metadata hash, so changing it rewrites the affected FTS rows on the next ingest; related notes read the config at query time and change immediately.

**Alternatives rejected**: keeping `source` built in (a name only some vaults use, silently special); making every declared field a sibling field (a low-cardinality field like `status` would relate most of the vault to itself).

