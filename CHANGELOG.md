# Changelog

Release PRs (`chore(release): X.Y.Z`) add a section here; the release
workflow uses it as the GitHub Release notes.

## 0.6.0 (2026-09-24)

### Breaking changes

- The index format changed. The first 0.6 command resets an older index and says so; rebuild it with `qkb ingest && qkb embed`
- `[search.fts_weights]` is now a table keyed by field name (`title = 5.0`, …); the old array form is rejected with a message (#34)
- `context` and `source` are no longer built in. Declare them in `[frontmatter.fields]` to search and embed them; `--context`/`--source` still work as shorthands for `--field` (#35)
- `qkb contexts` is replaced by `qkb fields` (#35)
- Related notes sharing a `source` now require `source` to be declared with `siblings = true`

### Features

- Every note with an `id` is indexed; the date falls back to `created`, `modified`, then the file's modification time, and the title to the file name (#33)
- Title, aliases and headings are ranking signals of their own (#34)
- Related notes from wikilinks in both directions, plus sibling fields: any declared field marked `siblings = true` (e.g. `source`, `author`) relates notes sharing a value and ranks like tags (#36)
- Optional local reranking: `qkb query --rerank`, MCP `rerank`, `[rerank]` (#37)
- Optional query expansion: `qkb query --expand`, MCP `expand`, `[expansion]` (#38)
- `--field` filters on any stored frontmatter property; `qkb_status` returns each declared field's most common values
- New guide: `docs/GUIDE.md`, how qkb reads your notes

## 0.5.1 (2026-09-23)

### Bug fixes

- `qkb status` no longer reports a false model mismatch for the `llama` provider right after a full re-embed; it now compares the provider's own model identity, as `qkb embed` does (#29)
- The model-mismatch warning and the search-time "embedding dimension changed" error now point to `qkb embed --full`, the command that actually re-embeds (#29)

### Changes

- Releases publish when a `chore(release): X.Y.Z` PR merges; no hand-pushed tag needed
- Homebrew formula points at 0.5.0

## 0.5.0 (2026-09-23)

### Features

- MCP over Streamable HTTP (`qkb mcp --http`), alongside stdio (#21)
- Watch mode (`qkb mcp --watch`, `qkb watch`) and WAL-mode SQLite for a long-running server (#22)
- Multiple vaults (`[[vaults]]`, `--vault`) (#23)
- Declared extra frontmatter properties (`[frontmatter.fields]`, `--field`) (#24)
- Container image and compose example (#25)

### Changes

- The legacy Python implementation was removed from the repo (#20)
- A config file that exists but doesn't parse is now an error instead of silently falling back to defaults
