# BM25 Architecture Research: Document-Level vs Chunk-Level in Hybrid Search

**Date**: 2026-04-03
**Context**: Design decision for QKB — choosing between document-level and chunk-level BM25 in a hybrid search system that serves both LLM agents and human users.

---

## The Question

In a hybrid search system (BM25 + vector), should BM25 operate at the document level (one FTS row per document with weighted metadata columns) or the chunk level (one FTS row per chunk)?

## What the Standard RAG Literature Says

**The dominant pattern in production RAG systems is chunk-level for both BM25 and vector search.** Systems like Elasticsearch, Weaviate, Azure AI Search, and Pinecone implement hybrid search at the same granularity — chunks for both backends, merged via Reciprocal Rank Fusion (RRF).

The rationale: chunks are the unit of retrieval that gets passed into LLM context windows, so both retrieval backends should score at that granularity for a clean RRF merge.

### Anthropic's Contextual Retrieval (2024)

Anthropic identified a key problem with chunk-level BM25: **chunks lose context from their parent document**. A chunk might say "The company's revenue grew by 3%" without specifying which company or time period.

Their solution: **prepend a brief (50-100 token) context summary to each chunk** before embedding and BM25 indexing. An LLM generates the context (e.g., "This chunk is from Uber's Q2 2024 earnings call transcript discussing revenue growth.").

Results:
- Contextual Embeddings alone: **35% reduction** in top-20 retrieval failure rate
- Contextual Embeddings + Contextual BM25: **49% reduction**
- Combined with reranking: **67% reduction**

This is chunk-level BM25, but with document context injected into each chunk's indexed text.

### Multi-Stage Retrieval Pattern

A separate body of research treats BM25 as a **high-recall first stage** that narrows the candidate set for a more expensive second stage (cross-encoder reranking or dense retrieval). In this pattern, BM25 operates at the document level as a filter, and passage-level retrieval happens downstream.

This is common in web-scale search (millions of documents) where running neural models over the full corpus is computationally infeasible. At personal knowledge base scale (hundreds to low thousands of documents), this optimization is unnecessary.

### Hybrid Search Performance

Research consistently shows hybrid retrieval outperforms either method alone:
- Recall: ~0.72 (BM25 alone) → ~0.91 (hybrid)
- Precision: ~0.68 (BM25 alone) → ~0.87 (hybrid)

RRF with k=60 is the standard zero-config default for merging ranked lists.

## What QMD Does (The Outlier Approach)

QMD (Tobi Lütke's search engine for markdown files) uses **document-level BM25 with weighted columns**:

```sql
-- FTS5 with three columns at different weights
CREATE VIRTUAL TABLE documents_fts USING fts5(
  filepath, title, body,
  tokenize='porter unicode61'
);

-- Queried with column weights: filepath 1.5, title 4.0, body 1.0
ORDER BY bm25(documents_fts, 1.5, 4.0, 1.0)
```

Meanwhile, **vector search operates at the chunk level** (900-token chunks with 15% overlap, embeddings per chunk, cosine similarity). Results are deduplicated up to documents before RRF merge.

This means QMD's two search backends operate at **different granularities**:
- BM25: document-level → returns ranked documents
- Vector: chunk-level → returns ranked chunks, deduplicated to documents
- RRF merges two document-level ranked lists

### Why This Works for QMD

1. **It's a file search tool** — the primary output is "which file is relevant," not "which passage within a file."
2. **Title weighting is powerful** — a 4× weight on title means keyword hits in filenames/headings dominate ranking. This is valuable when filenames are descriptive (e.g., `2026-03-15 Project Kickoff Transcript.md`).
3. **Documents are relatively short** — markdown files are typically hundreds to low thousands of tokens, not book-length.
4. **BM25's IDF signal is cleaner at document level** — "this term appears in 3 of 500 documents" is more meaningful than "this term appears in 12 of 8,000 chunks" where one long document contributes many chunks.
5. **Document length normalization** — BM25 already handles varying document lengths, so chunking for fairness is unnecessary.

### The Tradeoff

The cost of document-level BM25 is that you lose passage-level precision in the keyword search path. The vector search side provides passage retrieval, and the document-level BM25 provides a strong ranking signal about *which* document matters. RRF combines both.

## Alternative Considered: Deterministic Metadata Prefix

Instead of document-level BM25, one could prepend frontmatter metadata to each chunk before indexing:

```
[title: 2026-03-15 Project Kickoff Transcript | type: transcript | context: acme-corp-pm-role | tags: meeting, kickoff]

Alice Smith recommended moving the beta launch to mid-April...
```

**Pros**: Same granularity as vector search, clean RRF merge, no separate FTS table.
**Cons**: Loses fine-grained weight control per field, metadata terms in chunk text may interfere with BM25 scoring, not a true summary — just keywords.

Anthropic's research shows this pattern works best with **LLM-generated summaries** (not just metadata keywords), which adds ingestion cost and latency.

## Decision for QKB

**QKB uses document-level BM25 with weighted columns**, following QMD's architecture.

### Rationale

1. **QKB serves dual audiences** — LLM agents need passage-level context (handled by vector search on chunks), but human users want to find the right *document* to open in Obsidian. Document-level BM25 directly serves the human use case.

2. **Rich metadata columns** — QKB has richer metadata than QMD (title, context, tags, type, body). These are high-signal fields that benefit from explicit BM25 weighting. A title match for "project kickoff" should rank very differently from a body mention.

3. **Architectural precedent** — QMD has validated this approach in production with a similar tech stack (SQLite FTS5 + sqlite-vec, RRF fusion). The different-granularity merge works.

4. **Future LLM-generated summaries** — If chunk-level context summaries are added later (Anthropic's Contextual Retrieval approach), they can be added to the vector search path without disrupting the document-level BM25 architecture. The two approaches are complementary, not competing.

5. **Simpler schema** — One FTS5 table with weighted columns is simpler than prepending metadata to thousands of chunks and keeping it in sync.

### Proposed FTS5 Schema

```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  tags,
  context,
  body,
  type,
  tokenize='porter unicode61'
);

-- Weights: title 5.0, tags 3.0, context 2.0, body 1.0, type 0.5
ORDER BY bm25(documents_fts, 5.0, 3.0, 2.0, 1.0, 0.5)
```

The vector search path remains chunk-level (500-token chunks, cosine similarity on embeddings). RRF merges document-level BM25 results with chunk-level vector results deduplicated to documents.

---

## Sources

- [Anthropic — Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
- [Anthropic — Contextual Embeddings Guide (Claude Cookbook)](https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide)
- [VectorHub — Optimizing RAG with Hybrid Search & Reranking](https://superlinked.com/vectorhub/articles/optimizing-rag-with-hybrid-search-reranking)
- [System Overflow — Multi-Stage Retrieval: BM25 as First Stage](https://www.systemoverflow.com/learn/search-ranking/ranking-algorithms/multi-stage-retrieval-bm25-as-high-recall-first-stage)
- [Weaviate — Hybrid Search Explained](https://weaviate.io/blog/hybrid-search-explained)
- [Elastic — A Comprehensive Hybrid Search Guide](https://www.elastic.co/what-is/hybrid-search)
- [Meilisearch — Understanding Hybrid Search RAG](https://www.meilisearch.com/blog/hybrid-search-rag)
- [Genzeon — Hybrid Retrieval and Reranking in RAG](https://www.genzeon.com/hybrid-retrieval-deranking-in-rag-recall-precision/)
- [GitHub — Contextual RAG with Hybrid Search and Reranking](https://github.com/chatterjeesaurabh/Contextual-RAG-System-with-Hybrid-Search-and-Reranking)
- [Towards Data Science — RAG with Hybrid Search: How Does Keyword Search Work?](https://towardsdatascience.com/rag-with-hybrid-search-how-does-keyword-search-work/)
