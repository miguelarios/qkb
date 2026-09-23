# Changelog

Release PRs (`chore(release): X.Y.Z`) add a section here; the release
workflow uses it as the GitHub Release notes.

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
