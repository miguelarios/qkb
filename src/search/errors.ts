/**
 * Thrown for expected, user-facing search input validation failures: a
 * resolved limit < 1, an empty/whitespace-only filter value, an unparseable
 * date bound, a tier requiring an embedding provider that wasn't supplied,
 * an unknown tier, or an untrustworthy index (an interrupted/in-progress
 * `--full` re-embed, or a `chunks_vec` dimension that no longer matches
 * `cfg`).
 *
 * Every one of these mirrors a Python `raise ValueError(...)` site in
 * `service.py`/`filters.py`/`hybrid.py` — see those files' `ValueError`
 * raises. Kept as its own type (rather than the plain `Error` used
 * elsewhere) so callers that need Python's `except ValueError` semantics —
 * currently the MCP `qkb` tool — can narrow a catch to exactly these
 * expected failures and let anything else (a real bug, a SQLite error)
 * propagate uncaught instead of being silently packaged as a search error.
 * `src/cli/search.ts` doesn't need the narrowing (it treats every
 * `executeSearch` error as a usage error already), so it keeps catching
 * broadly via `instanceof Error`, which this class still satisfies.
 */
export class SearchValidationError extends Error {}
