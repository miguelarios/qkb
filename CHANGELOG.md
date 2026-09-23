# Changelog

Release PRs (`chore(release): X.Y.Z`) add a section here; the release
workflow uses it as the GitHub Release notes.

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
