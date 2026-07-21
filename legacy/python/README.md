# qkb (legacy Python implementation)

This is the original Python implementation of `qkb-search` (v0.3.0, published on PyPI). It has been
superseded by a TypeScript rewrite at the repository root — see the top-level
[README.md](../../README.md) for the current project.

This tree is kept runnable for reference and continuity: the tagged `v0.3.0` release remains
installable from PyPI, and the code/tests here are the authoritative behavioral spec that the
TypeScript port is built against (see `docs/plans/2026-07-20-typescript-rewrite.md` at the repo
root).

## Running locally

From this directory, with a virtualenv:

```bash
pip install -e ".[dev]"
pytest -q -m "not integration"
ruff check . && ruff format . && mypy src
```
