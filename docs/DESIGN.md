# QKB — Query Knowledge Base — Technical Design Document

**Project**: qkb (distribution name: `qkb-search`)
**Status**: Reconciled with ADR-001–008, ready for implementation
**Date**: 2026-07-06 (original design 2026-04-02)
**Positioning**: An Obsidian-native semantic search engine — QMD's search philosophy adapted for structured knowledge systems with frontmatter metadata
**Source of truth**: Obsidian vault markdown files with YAML frontmatter
**Decision log**: [adr/architecture-decisions.md](adr/architecture-decisions.md) — where this document and an ADR conflict, the ADR wins and this document has a bug.

---

## 1. What This Is

An on-device hybrid search engine for Obsidian vaults that understands frontmatter metadata. Where QMD treats markdown files as flat documents organized by directory, qkb treats them as nodes in a structured knowledge system — with types, contexts, sources, sibling relationships, and date semantics derived directly from YAML frontmatter.

Content opts in to indexing via frontmatter properties (`context` and/or `source`). The system is two subsystems sharing a SQLite database: an **ingestion pipeline** (batch, write-heavy, idempotent) and a **search engine** (read-only, latency-sensitive, multi-interface).

### Why not QMD out of the box?

QMD is a search engine for files on disk. It knows about collections (directories) and user-added context descriptions. But it has no awareness of frontmatter properties. It can't filter by `context: family-health` or `type: transcript`. It can't resolve date priority logic. It doesn't know that a transcript and its AI notes are siblings because they share a `source` slug. The entire frontmatter contract — the thing that makes search results *useful* rather than just *relevant* — doesn't exist in QMD's world.

What QMD does excellently is the search algorithm: query expansion, multi-path retrieval, RRF fusion, position-aware re-rank blending. This design borrows heavily from those techniques.

### Inspirations

- **QMD** (Tobi Lütke) — Search algorithm architecture: hybrid BM25 + vector, RRF fusion, query expansion, position-aware re-rank blending, MCP server, CLI interface
- **Granola AI** — Meeting transcription → structured notes → semantic search
- **Matthew Berman's OpenClaw knowledge base** — Validated the stack: local embeddings, SQLite + sqlite-vec, hybrid search
- **Google Personal Intelligence** — Aspirational vision for cross-context personal AI

---

## 2. Two Subsystems

The system splits cleanly into two independent subsystems that share a SQLite database but have completely different concerns.

### Subsystem 1: Ingestion Pipeline

Batch process. Write-heavy. Idempotent. Runs on a schedule or on-demand.

Concerns: vault walking, frontmatter parsing, content hashing, chunking, embedding, SQLite storage, re-indexing, de-indexing.

### Subsystem 2: Search Engine

Read-only. Latency-sensitive. Serves CLI, MCP, and HTTP consumers.

Concerns: query parsing, metadata filtering, BM25 keyword search, vector similarity search, RRF fusion, optional query expansion, optional LLM re-ranking, result formatting, sibling surfacing, document retrieval.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Obsidian Vault                                    │
│           (source of truth — markdown files with frontmatter)            │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
┌───────────────────────┐       ┌───────────────────────────────────────┐
│  INGESTION PIPELINE   │       │          SEARCH ENGINE                │
│                       │       │                                       │
│  Vault Walker         │       │  CLI: qkb search/query/get            │
│  Frontmatter Parser   │       │  MCP: tool server (stdio or HTTP)     │
│  Content Hasher       │       │  HTTP: FastAPI (optional)             │
│  Smart Chunker        │       │                                       │
│  Embedding Provider   │       │  Query Expansion (optional, needs LLM)│
│  SQLite Writer        │       │  BM25 Document Search (FTS5, weighted)│
│                       │       │  Vector Similarity Search (sqlite-vec)│
│  Runs: cron / on-     │       │  RRF Fusion (document-level)          │
│        demand / watch │       │  Position-Aware Re-ranking (optional) │
│                       │       │  Metadata Filtering                   │
│                       │       │  Source Grouping + Sibling Surfacing  │
│                       │       │  Document Retrieval (3 formats)       │
└───────────┬───────────┘       └──────────────┬────────────────────────┘
            │                                  │
            └──────────┐    ┌──────────────────┘
                       ▼    ▼
              ┌───────────────────────┐
              │   SQLite Database     │
              │                       │
              │  documents (metadata) │
              │  documents_fts (BM25) │
              │  chunks (text)        │
              │  chunks_vec (vectors) │
              │  tags                 │
              │  metadata (key-value) │
              └───────────────────────┘
```

---

## 3. Language & Dependencies

### Primary language: Python

Rationale: the transcription tooling upstream of qkb is already Python, `sqlite-vec` has first-class Python bindings, the data/ML ecosystem is Python-native, and a single language reduces operational complexity.

### Key dependencies

| Package | Purpose |
|---------|---------|
| `sqlite-vec` | Vector similarity search extension for SQLite |
| `python-frontmatter` | Parse YAML frontmatter from markdown |
| `click` | CLI framework |
| `rich` | Terminal output formatting |
| `mcp` | MCP server SDK (stdio transport, Phase 1) |
| `fastapi` + `uvicorn` | HTTP API (Phase 2, optional) |

Embedding and LLM dependencies are runtime-selected via the provider abstraction (see §7.3).

---

## 4. Obsidian Frontmatter Contract

### Universal properties (every note, enforced by Linter)

| Property | Source | Format | Example |
|----------|--------|--------|---------|
| `id` | Any UUID-producing method (plugin, macro, script — see ADR-003) | UUID v4 | `31d5dce7-b7d7-4d8d-8292-414d2c5340b6` |
| `type` | Linter default | Open string, default `note` | `transcript`, `ai-notes`, `jd`, `article` |
| `created` | Linter YAML Timestamp rule | ISO 8601 datetime with offset | `2026-03-15T13:50:19-06:00` |
| `title` | Linter/template | Free text; falls back to filename if absent | `Project Kickoff Transcript` |

Legacy key: a small number of older notes use `date created` instead of `created` (both hold ISO 8601 datetimes). The parser accepts `created` first, then `date created`, so no vault migration is required.

### Indexing properties (presence of either triggers ingestion)

| Property | Purpose | Example values |
|----------|---------|---------------|
| `context` | Topical grouping slug | `family-health`, `homelab-traefik`, `acme-corp-pm-role` |
| `source` | Sibling-joining key | `2026-03-15-project-kickoff`, `https://blog.example.com/post` |

An empty value does not trigger indexing: notes with `context:` or `source:` present but blank (observed in real vaults, e.g. left by templates) are treated as if the property were absent.

### Optional enrichment

| Property | Purpose |
|----------|---------|
| `tags` | Flat Obsidian labels for cross-cutting filters |
| `date` | Optional override — "when did this event happen" (see §5) |
| Domain-specific | `provider`, `interviewer`, etc. — stored in the `metadata` key-value table (ADR-006) |

### How this differs from QMD

QMD organizes by *collections* (directories) and *user-added context descriptions* (text attached to paths via `qmd context add`). qkb organizes by *frontmatter properties* that live inside each document. This means: metadata travels with the file (survives moves and renames), relationships like sibling documents are intrinsic (shared `source` slug), and filtering/scoping is always available because it's in the data, not in an external mapping.

---

## 5. Date Handling

The pipeline stores two timestamps per document: `created_at` (full ISO 8601 datetime from frontmatter, preserving time and offset) and `effective_date` (a `YYYY-MM-DD` date used for filtering). Resolution order for `effective_date`:

```
1. frontmatter["date"]     — explicit event date (optional, user- or pipeline-set)
2. frontmatter["created"]  — linter-stamped ISO datetime (or legacy "date created")
```

`created` reflects when the file was created in Obsidian. Most of the time, this is also when the event happened. But for pipeline-generated transcripts, the file might be created a day after the meeting or appointment. In that case, the pipeline stamps a `date` field with the actual event date, and the ingestion script uses that instead.

Real-vault caveats the parser must handle (all observed in the wild):

- `created` is an ISO 8601 datetime with timezone offset (`2026-01-08T13:50:19-06:00`) — the date part is extracted for `effective_date`.
- `date` values may be invalid: unexpanded Templater artifacts (`<% tp.date.now() %>`) or empty strings. Invalid `date` values are ignored with a warning, falling back to `created`.
- YAML may parse dates as `datetime.date`/`datetime.datetime` objects rather than strings — both are normalized.

```python
def resolve_effective_date(frontmatter: dict) -> str:
    """Priority: date > created > date created. Returns YYYY-MM-DD.

    Invalid or missing values fall through to the next source;
    a document with no parseable date at all is skipped with a warning.
    """
    for key in ("date", "created", "date created"):
        parsed = parse_date_lenient(frontmatter.get(key))  # str | date | datetime -> date | None
        if parsed:
            return parsed.isoformat()
    raise SkipDocument("no parseable date")
```

---

## 6. SQLite Schema

Single database file: `qkb.db`

> **Reconciliation note**: This schema reflects ADR-005 (document-level BM25 with weighted columns), ADR-006 (metadata key-value table), ADR-007 (FTS5 column weights), and ADR-008 (tags stored in both the junction table and FTS5). The original design used chunk-level FTS5 (`chunks_fts`); that was superseded.

### `documents`

```sql
CREATE TABLE documents (
    id             TEXT PRIMARY KEY,         -- UUID from frontmatter
    type           TEXT NOT NULL,            -- 'transcript', 'ai-notes', 'article', etc.
    context        TEXT,                     -- nullable topical grouping slug
    source         TEXT,                     -- nullable sibling-joining key
    effective_date TEXT NOT NULL,            -- YYYY-MM-DD, resolved: date > created (§5)
    created_at     TEXT NOT NULL,            -- full ISO 8601 datetime from frontmatter 'created'
    file_path      TEXT NOT NULL,            -- relative path from vault root
    content_hash   TEXT NOT NULL,            -- SHA-256 of markdown body
    title          TEXT,                     -- frontmatter 'title', fallback: filename without extension
    vault_name     TEXT NOT NULL DEFAULT 'Notes',  -- for constructing obsidian:// URIs at query time
    indexed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

### `documents_fts` (FTS5 — document-level BM25, ADR-005/007)

One row per document. Weighted columns let a title match rank very differently from a body mention. `doc_id` is stored but unindexed — it maps FTS5 hits back to `documents.id` (a TEXT UUID, which can't serve as an FTS5 content rowid).

```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
    title,                                   -- weight 5.0
    tags,                                    -- weight 3.0, space-separated (ADR-008)
    context,                                 -- weight 2.0
    body,                                    -- weight 1.0, full markdown body
    type,                                    -- weight 0.5
    doc_id UNINDEXED,                        -- documents.id (UUID)
    tokenize='porter unicode61'
);

-- Query shape:
-- SELECT doc_id, bm25(documents_fts, 5.0, 3.0, 2.0, 1.0, 0.5) AS score
-- FROM documents_fts WHERE documents_fts MATCH ?
-- ORDER BY score LIMIT ?;
-- (FTS5 bm25() returns lower-is-better; negate or sort ascending.)
```

Weight rationale (ADR-007): weights reflect signal density relative to text volume. Title is short and human-written — a keyword match there is highly intentional. Tags are human-curated labels. Context is a single slug. Body is the bulk of the text. Type is usually better used as a filter (`--type transcript`) than a free-text match. Tunable once real data is available. `source`, `date`, and `id` are excluded from FTS5 — they're identifiers and timestamps, not text to match against.

### `chunks`

Chunks exist for the *vector* path (and for showing matched passages). BM25 operates on whole documents; vectors operate on chunks.

```sql
CREATE TABLE chunks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index   INTEGER NOT NULL,          -- 0-based position within document
    chunk_text    TEXT NOT NULL,
    chunk_source  TEXT NOT NULL DEFAULT 'body',  -- 'body' or 'attachment:<filename>' (future)
    token_count   INTEGER,
    UNIQUE(document_id, chunk_index)
);
```

### `chunks_vec` (sqlite-vec)

```sql
CREATE VIRTUAL TABLE chunks_vec USING vec0(
    chunk_id  INTEGER PRIMARY KEY,           -- maps to chunks.id
    embedding float[768]                     -- dimension depends on model, configurable
);
```

### `tags` (junction table — exact filtering, ADR-008)

Tags live in **two places**: this junction table for exact AND-match filtering (`--tags phone-screen` must match the whole hyphenated tag, which FTS5's tokenizer would split), and the FTS5 `tags` column for BM25 relevance boosting. Both are written at ingestion time from the same frontmatter source, so they can't drift.

```sql
CREATE TABLE tags (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    PRIMARY KEY (document_id, tag)
);
```

### `metadata` (key-value — ADR-006)

Frontmatter properties beyond the core contract (`provider`, `interviewer`, `status`, …) are stored here as strings. Queryable for occasional filtering, but not first-class indexed columns — qkb never needs a schema change when a new domain appears.

```sql
CREATE TABLE metadata (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    PRIMARY KEY (document_id, key)
);
```

### `embedding_config`

```sql
CREATE TABLE embedding_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Stores: model_name, embedding_dim, provider_type
-- Checked at ingestion time — if model changes, forces full re-embed
```

### Indexes

```sql
CREATE INDEX idx_documents_context ON documents(context);
CREATE INDEX idx_documents_source ON documents(source);
CREATE INDEX idx_documents_type ON documents(type);
CREATE INDEX idx_documents_effective_date ON documents(effective_date);
CREATE INDEX idx_chunks_document_id ON chunks(document_id);
CREATE INDEX idx_metadata_key ON metadata(key, value);
```

---

## 7. Subsystem 1: Ingestion Pipeline

### 7.1 Vault Walker

Walks the Obsidian vault, parses frontmatter from every `.md` file, identifies indexable files (those with `context` or `source`), and diffs against the database using content hashing.

```python
for md_file in walk_vault(vault_path):
    fm = parse_frontmatter(md_file)

    if not fm.get("context") and not fm.get("source"):
        if exists_in_db(fm["id"]):
            delete_document(fm["id"])  # de-index: opt-out (cascades to chunks/tags/metadata; FTS row deleted explicitly)
        continue

    body = extract_markdown_body(md_file)
    content_hash = sha256(body)

    if exists_in_db(fm["id"]):
        stored = get_document(fm["id"])
        if stored.content_hash == content_hash:
            update_metadata_if_changed(fm, md_file)  # path, type, context, tags, extra metadata + FTS metadata columns
            continue
        else:
            delete_derived_rows(fm["id"])  # chunks, vectors, FTS row — content changed, re-ingest

    chunks = chunk_text(body)
    embeddings = embedding_provider.embed(chunks)
    store_document(fm, md_file, content_hash)        # documents row
    store_fts_row(fm, md_file, body)                 # documents_fts: title, tags, context, body, type
    store_chunks(fm["id"], chunks, embeddings)       # chunks + chunks_vec
    store_tags(fm["id"], fm.get("tags", []))         # junction table
    store_extra_metadata(fm["id"], fm)               # non-core frontmatter → metadata KV
```

Every mutation for one document happens in a single transaction — a crash mid-ingest never leaves a document half-indexed.

### 7.2 Smart Chunker (QMD-Inspired)

Splits markdown into chunks of approximately 500 tokens with 15% overlap, using a break-point scoring system that respects markdown structure.

**Break-point scores** — each potential cut point in the document is scored by structural importance:

| Pattern | Score | Rationale |
|---------|-------|-----------|
| `# Heading` | 100 | Major section boundary |
| `## Heading` | 90 | Subsection |
| `### Heading` | 80 | Sub-subsection |
| `#### Heading` | 70 | Minor heading |
| `##### / ######` | 60 / 50 | Deep headings |
| ` ``` ` (code fence boundary) | 80 | Code block start/end |
| `---` / `***` (horizontal rule) | 60 | Thematic break |
| `[timestamp] Speaker` pattern | 30 | Transcript speaker turn (custom) |
| Blank line (paragraph boundary) | 20 | Natural paragraph break |
| `- item` / `1. item` | 5 | List item boundary |
| Line break | 1 | Minimal break |

**Algorithm:**

1. Scan document for all potential break points, score each one.
2. Accumulate text toward the target token count (500).
3. When approaching the target, scan a window of ~100 tokens before the cutoff.
4. Score each break point in the window: `finalScore = baseScore × (1 - (distance/window)² × 0.7)` — the squared decay means closer breaks are preferred when scores are similar, but a heading 100 tokens back still beats a line break at the exact cutoff.
5. Cut at the highest-scoring break point.
6. Start the next chunk with overlap from the tail of the previous chunk.

**Code fence protection**: Break points inside code blocks are ignored — code stays together. If a code block exceeds the chunk size, it's kept whole when possible.

**Transcript awareness**: The `[00:00:00] Speaker` pattern scores 30 — higher than a bare line break (1) but lower than a paragraph boundary (20). This means the chunker prefers to cut between speaker turns when available, but won't force a cut at every speaker change.

**Chunk sizing rationale**: 500 tokens is a middle ground between QMD's 900 (optimized for LLM context windows) and the commonly recommended 400. qkb's rich metadata (`context`, `source`, `type`) provides contextual scaffolding that QMD needs larger chunks for, so slightly smaller chunks with better precision work well here. This is configurable and should be tuned empirically.

### 7.3 Embedding Provider Abstraction

The embedding layer supports multiple backends. The choice of provider and model is a configuration decision, not a code change.

```python
class EmbeddingProvider(Protocol):
    """Abstract interface for embedding providers."""
    def embed(self, texts: list[str]) -> list[list[float]]: ...
    def embed_query(self, query: str) -> list[float]: ...
    @property
    def dimension(self) -> int: ...
    @property
    def model_name(self) -> str: ...

class OllamaProvider(EmbeddingProvider):
    """Local embeddings via Ollama HTTP API.

    Default provider. Requires Ollama running with the model pulled.
    Supports nomic-embed-text, Qwen3-Embedding, or any Ollama-hosted model.
    Handles asymmetric prefixing (search_document: / search_query:) per model.
    """

class OpenAICompatibleProvider(EmbeddingProvider):
    """Remote embeddings via any OpenAI-compatible API.

    Works with OpenAI, Azure OpenAI, Together AI, or any provider
    that implements the /v1/embeddings endpoint.
    Configured via base_url + api_key.
    """

class FakeProvider(EmbeddingProvider):
    """Deterministic in-memory provider for unit tests and CI.

    Produces stable pseudo-embeddings from text hashes — no network,
    no model. Keeps the test suite runnable anywhere (including CI)
    and keeps the provider abstraction honest.
    """
```

**Model switching**: The `embedding_config` table tracks which model produced the current embeddings. If the configured model differs from what's stored, the ingestion pipeline requires a `--full` re-embed. This prevents mixing vectors from incompatible models.

**Default model**: `nomic-embed-text` via Ollama (768 dimensions, strong English retrieval, local, zero API cost). For multilingual needs (e.g., Spanish content), `Qwen3-Embedding-0.6B` is the recommended alternative — it covers 119 languages and runs through Ollama at similar speeds.

---

## 8. Subsystem 2: Search Engine

### 8.1 Four Search Tiers

Inspired by QMD's `search` / `vsearch` / `query` split, but with an additional tier separating hybrid search from LLM-enhanced search. Tiers 1-3 work with just SQLite + the embedding provider (for embedding queries). Tier 4 adds a local LLM. Nothing is forced.

| Tier | CLI Command | What It Does | Latency | Requires LLM? |
|------|-------------|-------------|---------|---------------|
| 1 | `qkb search` | BM25 document search (FTS5, weighted columns) | ~ms | No |
| 2 | `qkb vsearch` | Vector semantic search over chunks | ~100s of ms | No (just embedding) |
| 3 | `qkb query` | Hybrid: BM25 + vector + RRF fusion | ~100s of ms | No |
| 4 | `qkb query --rerank` | Hybrid + query expansion + LLM re-ranking | ~20-60s | Yes |

**Tier 1 — BM25 document search** (`search`): Fast exact-term matching via SQLite FTS5 against `documents_fts`, with column weights (title 5.0 > tags 3.0 > context 2.0 > body 1.0 > type 0.5). Returns ranked *documents* — best for when you know the specific words and want the right note to open. Matched-term snippets come from FTS5's `snippet()` on the body column.

**Tier 2 — Vector semantic search** (`vsearch`): Embeds the query via the configured provider, finds nearest neighbors in `chunks_vec` by cosine similarity. Returns matching *chunks*, deduplicated to documents (each document keeps its best-scoring chunk; the chunk text is shown as the matching passage). Best for conceptual queries where you don't know the exact terminology.

**Tier 3 — Hybrid with RRF** (`query`): Runs both searches in parallel and merges at the *document* level: BM25 already returns documents; the vector chunk list is deduplicated to documents (best chunk per document, preserving rank order) before fusion. RRF then merges the two document-level ranked lists. This is the default for most queries. Matching passages from the vector path are attached to results when available; BM25-only hits use FTS5 snippets.

**Tier 4 — Hybrid + LLM re-ranking** (`query --rerank`): Adds query expansion (LLM generates alternative phrasings) and position-aware re-ranking. Best quality, significant latency. Optional — requires a local LLM like Qwen3.5-2B via Ollama. **Phase 2** — in Phase 1 the flag exists and returns "re-ranking not configured".

### 8.2 Reciprocal Rank Fusion (RRF)

RRF merges two ranked lists by ignoring raw scores (which aren't comparable across backends — BM25's lower-is-better vs cosine similarity) and using only rank positions. Both lists are document-level at fusion time (see Tier 3 above).

Formula: for each result, `rrf_score = Σ(1 / (k + rank))` across all lists where it appears.

```python
def rrf_merge(result_lists: list[list], k: int = 60, weights: list[float] = None) -> list:
    """Merge multiple ranked lists using RRF.

    Args:
        result_lists: List of ranked result lists, each containing (document_id, score) tuples.
        k: RRF constant (default 60). Higher values compress rank differences.
        weights: Optional per-list weight multipliers (e.g., [2.0, 1.0, 1.0] to
                 double-weight the original query's results).
    """
    if weights is None:
        weights = [1.0] * len(result_lists)

    scores = defaultdict(float)

    for weight, results in zip(weights, result_lists):
        for rank, (document_id, _) in enumerate(results):
            scores[document_id] += weight * (1.0 / (k + rank + 1))

    return sorted(scores.items(), key=lambda x: x[1], reverse=True)
```

### 8.3 Query Expansion (Tier 4 only)

Before search, an LLM generates 1-2 alternative phrasings of the query. All queries run through both BM25 and vector search in parallel, producing multiple ranked lists that feed into RRF. The original query gets 2× weight so it dominates the fusion.

Example: "what did we decide about the migration timeline?" →
- Original (2× weight): "what did we decide about the migration timeline?"
- Expansion 1: "database migration schedule decision cutover"
- Expansion 2: "project plan timeline commitment meeting"

### 8.4 Position-Aware Re-Rank Blending (Tier 4 only)

After RRF fusion and LLM re-ranking, two signals exist per result: the RRF score (retrieval quality) and the re-ranker score (LLM relevance judgment). The blend ratio depends on RRF rank position:

| RRF Rank | Retrieval Weight | Re-ranker Weight | Rationale |
|----------|-----------------|------------------|-----------|
| 1-3 | 75% | 25% | Top results are high-confidence — don't let re-ranker override |
| 4-10 | 60% | 40% | Moderate confidence — trust both signals |
| 11+ | 40% | 60% | Low retrieval confidence — lean on re-ranker |

This prevents the LLM re-ranker from accidentally burying an exact keyword match that RRF ranked #1. Borrowed directly from QMD's architecture.

### 8.5 Metadata Filtering

Filters are applied as SQL WHERE clauses BEFORE search, narrowing the candidate set. This is the core advantage over QMD — filters operate on frontmatter-derived metadata. For the BM25 path, the FTS5 match is joined against `documents` (via `doc_id`) with the filter clause; for the vector path, the candidate chunk set is restricted to documents passing the filter.

```python
def build_filter_clause(
    context=None, source=None, doc_type=None,
    tags=None, date_from=None, date_to=None
) -> tuple[str, list]:
    conditions, params = [], []

    if context:
        conditions.append("d.context = ?"); params.append(context)
    if source:
        conditions.append("d.source = ?"); params.append(source)
    if doc_type:
        conditions.append("d.type = ?"); params.append(doc_type)
    if date_from:
        conditions.append("d.effective_date >= ?"); params.append(date_from)
    if date_to:
        conditions.append("d.effective_date <= ?"); params.append(date_to)
    if tags:
        placeholders = ",".join("?" * len(tags))
        conditions.append(f"""d.id IN (
            SELECT document_id FROM tags WHERE tag IN ({placeholders})
            GROUP BY document_id HAVING COUNT(DISTINCT tag) = ?
        )""")
        params.extend(tags); params.append(len(tags))

    return (" AND ".join(conditions) if conditions else "1=1"), params
```

Tag filtering uses the junction table (exact match, AND semantics); tag *ranking* influence comes from the FTS5 `tags` column (ADR-008).

### 8.6 Source Grouping & Sibling Surfacing

After scoring, results are grouped by `source` so sibling documents appear together. This is something QMD cannot do — because qkb has the `source` slug, it automatically surfaces related documents without the consumer needing a second search.

When a search hit comes from a document with a `source`, the response also includes metadata about sibling documents sharing that source (even if those siblings didn't match the query):

```json
{
  "results": [
    {
      "document_id": "31d5dce7-...",
      "title": "2026-03-15 Project Kickoff Transcript",
      "type": "transcript",
      "context": "acme-corp-pm-role",
      "source": "2026-03-15-project-kickoff",
      "effective_date": "2026-03-15",
      "score": 0.87,
      "file_path": "02-Areas/Work/2026-03-15 Project Kickoff Transcript.md",
      "obsidian_uri": "obsidian://open?vault=Notes&file=02-Areas%2FWork%2F2026-03-15%20Project%20Kickoff%20Transcript",
      "chunks": [
        { "text": "...", "score": 0.87, "chunk_source": "body" }
      ],
      "siblings": [
        {
          "document_id": "a2b3c4d5-...",
          "title": "2026-03-15 Project Kickoff Notes",
          "type": "ai-notes",
          "file_path": "02-Areas/Work/2026-03-15 Project Kickoff Notes.md",
          "obsidian_uri": "obsidian://open?vault=Notes&file=02-Areas%2FWork%2F2026-03-15%20Project%20Kickoff%20Notes"
        }
      ]
    }
  ]
}
```

### 8.7 Document Retrieval — Three Formats

Every document can be retrieved by UUID. The response includes three access formats for different consumers:

| Format | Purpose | Consumer |
|--------|---------|----------|
| `file_path` | Relative path from vault root | LLM agents with filesystem access |
| `obsidian_uri` | `obsidian://open?vault=Notes&file=<path>` | Human-facing UIs — click to open in Obsidian |
| `raw_text` | Full markdown body | LLM agents without filesystem access, MCP consumers |

The Obsidian URI is constructed at query time from the vault name and current file path: `obsidian://open?vault=<vault_name>&file=<path_without_extension>` (ADR-002 — standard URIs, no plugin dependency). Since it's path-based, it won't survive file moves — but that's fine. The UUID is the stable identifier in the database, and the path gets updated on every ingestion run. If a URI goes stale between ingestions, the UUID can always locate the document.

```bash
qkb get <UUID>               # metadata + file path + obsidian URI
qkb get <UUID> --raw         # include full markdown body
qkb get <UUID> --open        # open in Obsidian via URI
```

---

## 9. Interfaces

qkb exposes three interfaces. All three call the same underlying search and retrieval logic.

### 9.1 CLI (Click)

```
# Ingestion
qkb ingest [--vault-path PATH] [--db-path PATH] [--full]
qkb ingest --stats

# Search (four tiers)
qkb search "query"              [filters] [--limit N]
qkb vsearch "query"             [filters] [--limit N]
qkb query "query"               [filters] [--limit N]
qkb query "query" --rerank      [filters] [--limit N]

# Filters (apply to any search command)
--context CTX    --type TYPE    --tags T1,T2    --date-from YYYY-MM-DD    --date-to YYYY-MM-DD

# Output formats
--json          # structured JSON
--files         # uuid,score,filepath,context (for piping)

# Retrieval
qkb get <UUID>               # metadata + paths + obsidian URI
qkb get <UUID> --raw         # include full markdown body
qkb get <UUID> --open        # open in Obsidian

# Status
qkb status                   # index health, counts, last ingestion
```

### 9.2 MCP Server

Exposes search and retrieval as MCP tools for LLM agents. Supports stdio (subprocess) in Phase 1; HTTP (long-lived daemon) in Phase 2.

```yaml
tools:
  - qkb:
      description: "Search personal knowledge base with hybrid BM25 + vector retrieval"
      params:
        query: string (required)
        context: string (optional)
        type: string (optional)
        tags: list[string] (optional)
        date_from: string (optional)
        date_to: string (optional)
        limit: int (optional, default 10)
        rerank: bool (optional, default false)

  - qkb_get:
      description: "Retrieve a document by UUID"
      params:
        document_id: string (required — full or prefix)
        include_raw: bool (optional, default false)
        include_siblings: bool (optional, default true)

  - qkb_status:
      description: "Index health and stats"
```

```bash
qkb mcp                       # stdio (subprocess per client)
qkb mcp --http                # HTTP daemon on localhost:8181  (Phase 2)
qkb mcp --http --port 8080    #                                (Phase 2)
qkb mcp --http --daemon       # background, PID file           (Phase 2)
qkb mcp stop                  #                                (Phase 2)
```

### 9.3 HTTP API (Phase 2, Optional)

Thin FastAPI wrapper for web UIs or non-MCP integrations. Not part of Phase 1.

```
GET  /search?q=...&context=...&type=...&limit=...
GET  /get/<uuid>?raw=true
GET  /status
```

---

## 10. Project Structure

```
qkb/
├── pyproject.toml              # dist name qkb-search, console script qkb
├── README.md
├── LICENSE
├── .github/
│   └── workflows/
│       ├── ci.yml              # lint + typecheck + tests (push/PR)
│       └── release.yml         # build + PyPI trusted publishing (v* tags)
├── docs/
│   ├── PRD.md
│   ├── DESIGN.md               # this document
│   ├── adr/                    # decision log
│   └── plans/                  # implementation plans
├── src/
│   └── qkb/
│       ├── __init__.py
│       ├── cli.py                  # Click CLI commands
│       ├── config.py               # Paths, defaults, constants
│       ├── db.py                   # SQLite connection, schema, migrations
│       ├── models.py               # Dataclasses: Document, Chunk, SearchResult, etc.
│       │
│       ├── ingest/                 # Subsystem 1
│       │   ├── __init__.py
│       │   ├── walker.py           # Vault walking + frontmatter parsing
│       │   ├── chunker.py          # Smart break-point chunking
│       │   ├── hasher.py           # SHA-256 content hashing
│       │   └── storage.py          # SQLite write operations (documents, FTS, chunks, tags, metadata)
│       │
│       ├── search/                 # Subsystem 2
│       │   ├── __init__.py
│       │   ├── bm25.py             # FTS5 document search (weighted columns)
│       │   ├── vector.py           # sqlite-vec chunk search + document dedup
│       │   ├── hybrid.py           # RRF fusion + tier orchestration
│       │   ├── reranker.py         # LLM re-ranking + position-aware blending (Phase 2)
│       │   ├── expander.py         # LLM query expansion (Phase 2)
│       │   ├── filters.py          # Metadata filter builder
│       │   ├── grouping.py         # Source grouping + sibling surfacing
│       │   └── retrieval.py        # Document get by UUID (3 formats)
│       │
│       ├── embed/                  # Embedding provider abstraction
│       │   ├── __init__.py
│       │   ├── base.py             # EmbeddingProvider protocol
│       │   ├── ollama.py           # Ollama HTTP provider
│       │   ├── openai_compat.py    # OpenAI-compatible remote provider
│       │   └── fake.py             # Deterministic test provider
│       │
│       └── server/                 # Interface layer
│           ├── __init__.py
│           ├── mcp.py              # MCP tool server (stdio; HTTP in Phase 2)
│           └── http.py             # FastAPI REST wrapper (Phase 2)
│
└── tests/
    ├── test_chunker.py
    ├── test_walker.py
    ├── test_storage.py
    ├── test_bm25.py
    ├── test_vector.py
    ├── test_rrf.py
    ├── test_filters.py
    ├── test_cli.py
    ├── test_mcp.py
    └── fixtures/                   # Synthetic markdown files with frontmatter (no real personal data)
```

---

## 11. Configuration

```python
# config.py — defaults, overridable via env vars, config file, or CLI flags

from pathlib import Path

# Vault
VAULT_PATH = Path.home() / "Notes"
VAULT_NAME = "Notes"                          # for Obsidian URI construction

# Database
DB_PATH = Path.home() / ".local/share/qkb/qkb.db"

# Embedding
EMBEDDING_PROVIDER = "ollama"                 # "ollama" | "openai_compatible"
EMBEDDING_MODEL = "nomic-embed-text"          # or "qwen3-embedding-0.6b", etc.
EMBEDDING_DIM = 768
OLLAMA_HOST = "http://localhost:11434"
# For remote provider:
# EMBEDDING_API_BASE = "https://api.openai.com/v1"
# EMBEDDING_API_KEY = "${API_KEY}"            # env var, never committed

# Chunking
CHUNK_TARGET_TOKENS = 500
CHUNK_OVERLAP_PERCENT = 15                    # 15% of target = 75 tokens

# Search
DEFAULT_SEARCH_LIMIT = 10
RRF_K = 60
VEC_CANDIDATES = 30
FTS_CANDIDATES = 30
FTS_WEIGHTS = (5.0, 3.0, 2.0, 1.0, 0.5)       # title, tags, context, body, type (ADR-007)

# Re-ranking (tier 4, Phase 2)
RERANK_MODEL = "qwen3.5:2b"                   # via Ollama
RERANK_ENABLED = False                        # off by default
QUERY_EXPANSION_ENABLED = False

# Frontmatter keys
FM_ID = "id"
FM_TYPE = "type"
FM_TITLE = "title"
FM_CONTEXT = "context"
FM_SOURCE = "source"
FM_DATE = "date"
FM_CREATED = "created"
FM_CREATED_LEGACY = "date created"            # older notes; same ISO datetime format
FM_TAGS = "tags"
```

---

## 12. Packaging, CI/CD & Distribution

### Packaging

- **Distribution name `qkb-search`** (the name `qkb` is taken on PyPI by an unrelated package); **import package `qkb`**; **console script `qkb`**. Same pattern as `beautifulsoup4`/`bs4`.
- `pyproject.toml` with the **hatchling** build backend, PEP 621 metadata, `requires-python = ">=3.11"`.
- Version single-sourced in `pyproject.toml`; releases are cut by tagging `vX.Y.Z`.
- Install paths: `pip install qkb-search`, `pipx install qkb-search`, `uvx --from qkb-search qkb`.

### CI workflow (`.github/workflows/ci.yml`)

On every push and pull request:

- **ruff** — lint + format check
- **mypy** — type check
- **pytest** — unit tests on a matrix: {ubuntu, macos} × Python {3.11, 3.12, 3.13}

Tests never require Ollama: unit tests use the `FakeProvider`; tests that need a real embedding model are marked `integration` and excluded in CI. This keeps CI fast and forces the provider abstraction to stay honest.

### Release workflow (`.github/workflows/release.yml`)

On pushing a `v*` tag:

1. Build sdist + wheel (`python -m build`).
2. Publish to PyPI via **trusted publishing** (OIDC) — no long-lived API token stored in GitHub.
3. Create a GitHub release with the artifacts attached.

One-time manual setup: register the GitHub repo as a *pending publisher* for `qkb-search` on PyPI before the first release.

### Public repo hygiene

The repo is public. All docs, examples, tests, and fixtures use synthetic data only (RFC 2606 domains, reserved IPs, fiction-range phone numbers, synthetic names/contexts). Real vault content only ever exists in the local runtime database, which is never committed. `.gitignore` covers `*.db`, local config, and virtualenvs; the repo owner's global gitleaks pre-commit hook provides a second line of defense.

---

## 13. Deployment

qkb runs in multiple environments with the same codebase.

### Local (macOS)

```bash
pip install qkb-search
qkb ingest
qkb query "traefik certificate renewal"
qkb mcp  # stdio for Claude Code / Claude Desktop
```

### Docker (home server / NAS)

```yaml
services:
  qkb:
    build: .
    volumes:
      - /path/to/obsidian-vault:/vault:ro
      - /path/to/qkb-data:/data
    environment:
      - VAULT_PATH=/vault
      - DB_PATH=/data/qkb.db
      - OLLAMA_HOST=http://ollama:11434
    ports:
      - "8181:8181"
```

Cron ingestion:
```bash
*/15 * * * * docker exec qkb qkb ingest
```

MCP daemon for remote agents (Phase 2):
```bash
docker exec qkb qkb mcp --http --daemon
```

---

## 14. Phased Implementation

### Phase 1: Core (MVP)

Both subsystems with tiers 1-3 (no LLM re-ranking), CLI, MCP stdio server, packaging, and CI/CD.

- Repo scaffolding: pyproject (qkb-search), CI workflow, release workflow
- Vault walker + frontmatter parser
- Smart chunker (break-point scoring with transcript awareness)
- Embedding provider abstraction (Ollama + Fake providers)
- SQLite schema + storage with content-hash diffing (documents, documents_fts, chunks, chunks_vec, tags, metadata)
- BM25 document search (FTS5 weighted columns)
- Vector search (sqlite-vec) with document dedup
- Hybrid search with document-level RRF fusion
- Metadata filtering (context, source, type, tags, date range)
- Source grouping + sibling surfacing
- Document retrieval (3 formats: file path, Obsidian URI, raw text)
- CLI (Click) with all four search commands (tier 4 returns "reranking not configured" until Phase 2)
- MCP server (stdio)
- v0.1.0 released to PyPI

### Phase 2: Enhanced Search

LLM-powered search features (tier 4) and extended interfaces.

- Query expansion via local LLM
- LLM re-ranking with position-aware blending
- MCP HTTP transport (daemon mode)
- HTTP REST API (FastAPI)

### Phase 3: Attachment Extraction (Future)

Extend the ingestion pipeline to resolve and extract content from attachments referenced in notes (`![[photo.png]]`, `![[scan.pdf]]`). The attachment is resolved relative to the vault, its content extracted, and stored as additional chunks linked to the parent document. Extracted content lives in the database only — the note stays clean.

The `chunk_source` column distinguishes body chunks from attachment chunks: `"body"` vs `"attachment:scan.pdf"`. Search results indicate when a match came from an attachment.

Extraction by file type:
- **Images** (PNG, JPEG): Vision model (LLaVA, Qwen-VL via Ollama) generates a text description; that text is chunked and embedded normally
- **PDFs**: Extract embedded text if available; fall back to OCR (Azure Document Intelligence or local alternative)
- **Videos**: Not in scope

### Phase 4: Additional Enhancements (Future)

- Web search UI served from the home server
- Filesystem watcher (`watchdog`) for real-time indexing
- Domain-specific extensions (e.g., recipe-aware chunking for a dedicated context)
- Fine-tuned query expansion model (following QMD's approach)

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **BM25** | Best Matching 25 — a keyword relevance scoring algorithm. Considers term frequency, inverse document frequency, and document length normalization. Implemented by SQLite FTS5. |
| **RRF** | Reciprocal Rank Fusion — merges multiple ranked lists using `score = Σ(1/(k+rank))`. Ignores raw scores, uses only rank positions. Standard `k=60`. |
| **FTS5** | SQLite's full-text search extension. Provides BM25 scoring out of the box. |
| **sqlite-vec** | SQLite extension for vector similarity search. Stores embeddings and performs nearest-neighbor lookups. |
| **Position-aware blending** | After RRF + re-ranking, the blend ratio between retrieval and re-ranker scores varies by rank position. High-ranked results trust retrieval more; low-ranked results trust the re-ranker more. |
| **Query expansion** | An LLM generates alternative phrasings of a query before search. All variants run through both search backends, with the original weighted higher in fusion. |
| **Sibling documents** | Documents sharing the same `source` slug — e.g., a transcript and its AI notes from the same recording. |
| **Effective date** | Resolved date for a document: `frontmatter["date"]` if present, otherwise `frontmatter["date created"]`. |
| **Smart chunking** | Break-point-scored text splitting that respects markdown structure (headings, paragraphs, code blocks, speaker turns). |
| **Trusted publishing** | PyPI's OIDC-based release mechanism — GitHub Actions authenticates directly to PyPI without a stored API token. |

## Appendix B: QMD Feature Comparison

| Feature | QMD | qkb |
|---------|-----|------------|
| **Language** | TypeScript (node-llama-cpp) | Python (Ollama / OpenAI-compatible) |
| **Metadata model** | Collections (dirs) + user-added context descriptions | Frontmatter: type, context, source, date, tags |
| **Indexing trigger** | All files in a collection | Opt-in via `context` or `source` in frontmatter |
| **BM25 granularity** | Document-level, weighted columns | Document-level, weighted columns (ADR-005) |
| **Sibling documents** | Not supported | Automatic via shared `source` slug |
| **Date handling** | File modification date | `date` > `created` priority resolution |
| **Filtering** | By collection | By context, source, type, tags, date range |
| **Embedding** | embeddinggemma-300M (GGUF, in-process) | Configurable: Ollama, OpenAI-compatible |
| **Search tiers** | 3 (search, vsearch, query) | 4 (search, vsearch, query, query --rerank) |
| **Re-ranking** | Always on for `query` | Optional, explicit `--rerank` flag (Phase 2) |
| **Query expansion** | Fine-tuned 1.7B model | Optional, via local LLM (tier 4, Phase 2) |
| **Document retrieval** | By path or 6-char docid | By frontmatter UUID → file path + Obsidian URI + raw text |
| **MCP server** | Yes (stdio + HTTP) | Yes (stdio Phase 1, HTTP Phase 2) |
| **Distribution** | — | PyPI (`qkb-search`), GitHub Actions CI/CD |
| **Attachment extraction** | No | Planned (Phase 3) |
