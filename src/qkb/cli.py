"""qkb command-line interface (DESIGN.md §9.1)."""

from __future__ import annotations

import json as jsonlib
import sys

import click
from rich.console import Console
from rich.table import Table

from qkb.config import Config, load_config
from qkb.db import connect
from qkb.embed import get_provider
from qkb.ingest.pipeline import ingest_vault
from qkb.ingest.storage import Storage
from qkb.search.filters import Filters
from qkb.search.retrieval import DocumentFileMissing, get_document
from qkb.search.service import execute_search

console = Console()


def _cfg() -> Config:
    return load_config()


def _conn(cfg: Config):
    return connect(cfg.db_path, cfg.embedding_dim)


def search_options(fn):
    fn = click.option("--context", default=None)(fn)
    fn = click.option("--source", default=None)(fn)
    fn = click.option("--type", "doc_type", default=None)(fn)
    fn = click.option("--tags", default=None, help="comma-separated, AND semantics")(fn)
    fn = click.option("--date-from", default=None)(fn)
    fn = click.option("--date-to", default=None)(fn)
    fn = click.option("--limit", default=None, type=int)(fn)
    fn = click.option("--json", "as_json", is_flag=True)(fn)
    fn = click.option("--files", "as_files", is_flag=True)(fn)
    return fn


def _filters(context, source, doc_type, tags, date_from, date_to) -> Filters:
    return Filters(
        context=context,
        source=source,
        doc_type=doc_type,
        tags=[t.strip() for t in tags.split(",") if t.strip()] if tags else None,
        date_from=date_from,
        date_to=date_to,
    )


def _emit(results: list[dict], as_json: bool, as_files: bool) -> None:
    if as_json:
        click.echo(jsonlib.dumps(results, indent=2))
        return
    if as_files:
        for r in results:
            click.echo(f"{r['document_id']},{r['score']},{r['file_path']},{r['context'] or ''}")
        return
    table = Table(show_lines=False)
    for col in ["Title", "Type", "Context", "Date", "Score"]:
        table.add_column(col)
    for r in results:
        table.add_row(
            r["title"], r["type"], r["context"] or "-", r["effective_date"], f"{r['score']:.4f}"
        )
    console.print(table)
    for r in results:
        if r["matched_text"]:
            console.print(f"[dim]{r['title']}:[/dim] {r['matched_text'][:200]}")


def _do_search(
    tier: str,
    query,
    context,
    source,
    doc_type,
    tags,
    date_from,
    date_to,
    limit,
    as_json,
    as_files,
    rerank=False,
):
    cfg = _cfg()
    if rerank:
        click.echo("re-ranking not configured (Phase 2)", err=True)
        sys.exit(2)
    conn = _conn(cfg)
    provider = None if tier == "bm25" else get_provider(cfg)
    try:
        results = execute_search(
            conn,
            cfg,
            provider,
            query,
            _filters(context, source, doc_type, tags, date_from, date_to),
            limit,
            tier,
        )
    except ValueError as e:
        raise click.UsageError(str(e)) from e
    _emit(results, as_json, as_files)


@click.group()
def cli() -> None:
    """qkb — hybrid search for Obsidian vaults."""


@cli.command()
@click.option("--full", is_flag=True, help="force full re-embed")
def ingest(full: bool) -> None:
    cfg = _cfg()
    conn = _conn(cfg)
    provider = get_provider(cfg)
    stats = ingest_vault(conn, cfg, provider, full=full)
    click.echo(
        f"scanned={stats.scanned} indexed={stats.indexed} updated={stats.updated} "
        f"unchanged={stats.unchanged} deindexed={stats.deindexed} skipped={stats.skipped}"
    )


@cli.command()
@click.argument("query")
@search_options
def search(query, context, source, doc_type, tags, date_from, date_to, limit, as_json, as_files):
    """Tier 1: BM25 keyword search."""
    _do_search(
        "bm25", query, context, source, doc_type, tags, date_from, date_to, limit, as_json, as_files
    )


@cli.command()
@click.argument("query")
@search_options
def vsearch(query, context, source, doc_type, tags, date_from, date_to, limit, as_json, as_files):
    """Tier 2: vector semantic search."""
    _do_search(
        "vector",
        query,
        context,
        source,
        doc_type,
        tags,
        date_from,
        date_to,
        limit,
        as_json,
        as_files,
    )


@cli.command()
@click.argument("query")
@click.option("--rerank", is_flag=True)
@search_options
def query(
    query, rerank, context, source, doc_type, tags, date_from, date_to, limit, as_json, as_files
):
    """Tier 3: hybrid BM25 + vector with RRF fusion."""
    _do_search(
        "hybrid",
        query,
        context,
        source,
        doc_type,
        tags,
        date_from,
        date_to,
        limit,
        as_json,
        as_files,
        rerank=rerank,
    )


@cli.command()
@click.argument("id_or_prefix")
@click.option("--raw", is_flag=True)
@click.option("--open", "open_", is_flag=True, help="open in Obsidian")
def get(id_or_prefix, raw, open_):
    cfg = _cfg()
    conn = _conn(cfg)
    try:
        doc = get_document(conn, id_or_prefix, vault_path=cfg.vault_path, include_raw=raw)
    except DocumentFileMissing as e:
        click.echo(str(e), err=True)
        sys.exit(1)
    except (KeyError, ValueError) as e:
        click.echo(str(e), err=True)
        sys.exit(1)
    if open_:
        import webbrowser

        webbrowser.open(doc["obsidian_uri"])
    click.echo(jsonlib.dumps(doc, indent=2))


@cli.command()
@click.option("--json", "as_json", is_flag=True)
def contexts(as_json):
    rows = Storage(_conn(_cfg())).list_contexts()
    if as_json:
        click.echo(jsonlib.dumps(rows, indent=2))
    else:
        for r in rows:
            click.echo(f"{r['context']}  ({r['count']})  {r['description'] or ''}")


@cli.group()
def context() -> None:
    """Manage context descriptions."""


@context.command()
@click.argument("label")
@click.argument("description", required=False)
@click.option("--remove", is_flag=True)
def describe(label, description, remove):
    storage = Storage(_conn(_cfg()))
    if remove:
        storage.set_context_description(label.strip().lower(), None)
    elif description:
        storage.set_context_description(label.strip().lower(), description)
    else:
        raise click.UsageError("provide a description or --remove")


@cli.command()
def status():
    st = Storage(_conn(_cfg())).stats()
    click.echo(jsonlib.dumps(st, indent=2))


@cli.command()
def mcp() -> None:
    """Run the MCP stdio server."""
    from qkb.server.mcp import run_server

    run_server()


main = cli

if __name__ == "__main__":
    main()
