# How qkb reads your notes

This guide explains what qkb does with a note: which frontmatter it
understands, what you can add, how results are ranked, and how related notes
are found. For install and commands, see the [README](../README.md). The
reasoning behind each choice is in the [ADRs](adr/architecture-decisions.md).

- [The one requirement: `id`](#the-one-requirement-id)
- [Core properties](#core-properties)
- [Extra properties](#extra-properties)
- [Descriptions: who reads them](#descriptions-who-reads-them)
- [Sibling fields](#sibling-fields)
- [Related notes](#related-notes)
- [How results are ranked](#how-results-are-ranked)
- [Filtering](#filtering)
- [When a config change takes effect](#when-a-config-change-takes-effect)
- [Example configuration](#example-configuration)

## The one requirement: `id`

A note is indexed if its frontmatter has an `id`. Nothing else is required.

```yaml
---
id: f47ac10b-58cc-4372-a567-0e02b2c3d401
---
```

The `id` is how qkb tells notes apart. It has to be unique across every vault
qkb indexes, and it should never change. Renaming or moving the file is then
harmless: qkb follows the note instead of re-indexing it as new. Any string
works; UUIDs are the usual choice (for example the Obsidian Linter or a
template can insert one).

If a second note has an `id` that's already taken, it is skipped and reported
as a duplicate. `qkb ingest` also prints how many notes were skipped for
having no `id`. qkb never writes to your vault, so it won't add ids for you.

## Core properties

These are always understood. Each row lists the frontmatter names qkb looks
for (first one present wins) and what it falls back to.

| Property | Frontmatter names | If missing | Used for |
|---|---|---|---|
| `id` | `id` | note is skipped | identity |
| `title` | `title` | the file name | ranking (weight 5), results |
| `aliases` | `aliases`, `alias` | none | ranking (weight 5), resolving `[[links]]` |
| `tags` | `tags`, `tag` | none | ranking (weight 3), `--tags` filter |
| `type` | `type` | `note` | `--type` filter, ranking (weight 0.5) |
| `date` | `date`, then `created`, `modified` | the file's modification time | date filters, results (`effective_date`) |
| `created` | `created`, `date created` | none | date fallback |
| `modified` | `modified`, `updated`, `date modified` | none | date fallback |

qkb also reads the note body itself:

- **Headings** (`# …` through `###### …`, outside fenced code blocks) are a
  ranking signal of their own (weight 3): a heading is a short, deliberate
  summary of what follows.
- **Body text** is chunked and embedded for semantic search, and matched by
  keyword search (weight 1).
- **Wikilinks** (`[[Note]]`, `[[Note|label]]`, `[[Note#Heading]]`,
  `![[Embed]]`) become [related notes](#related-notes).

Your vault uses other names? Map them in the config:

```toml
[frontmatter]
id = ["uuid", "id"]
created = ["created", "date created", "created_at"]
```

## Extra properties

Every other frontmatter property is **stored**: `qkb get` returns it under
`metadata`, and you can filter on it with `--field`. But a stored property
doesn't affect search until you **declare** it:

```toml
[frontmatter.fields]
project = "Project this note belongs to"
company = "Employer or client the note is about"
```

A declared property is:

- **searchable**: keyword search matches its values (weight 2);
- **embedded**: each chunk is embedded with `project: Apollo` lines in front of
  it, so semantic search takes the property into account;
- **returned**: search results, `--json` and MCP results carry it under
  `fields`;
- **described to agents**: its name and description are sent to AI agents
  (see below).

Declare the properties that say what a note is *about*. Leave out
bookkeeping ones (sync ids, plugin state, `cssclasses`). They would add noise
to ranking and to the embeddings.

`qkb fields` lists the declared properties, how many notes carry each, and
their most common values.

## Descriptions: who reads them

A declared property's description is written for **AI agents** using qkb
over MCP, not for the search models. It appears in two places:

- the `qkb` search tool's description, which the agent reads before it
  searches;
- `qkb_status`, next to the property's most common values (`field_values`).

From these an agent learns that it can narrow a search with, for example,
`fields: {"company": "Acme"}`, and which values exist. Turning a request
into structured filters this way is sometimes called *self-querying*.

The embedding model and the reranker never see descriptions. They see the
property *values* (`company: Acme`), which is what describes the note.
Write descriptions the way you would explain the property to a new
assistant: what it holds, and when it's worth filtering on.

## Sibling fields

Some properties group notes that belong together. Every note clipped from
the same web page shares a `source`. A meeting transcript and the notes
taken from it share a `source` too. So do all papers by one `author`, or all
entries in one `series`. qkb calls these **sibling fields**: notes that share
a value are siblings.

Mark a declared property as a sibling field with the table form:

```toml
[frontmatter.fields]
source = { description = "Where a note came from: a web page, meeting or book", siblings = true }
author = { description = "Who wrote the original", siblings = true }
project = "Project this note belongs to"   # ordinary declared field
```

A sibling field does everything a declared field does, and additionally:

- **Siblings appear as related notes.** Every result lists the notes sharing
  its value, with `relation: "sibling"` and the `field` and `value` they
  share. An agent that finds one clip of a page also sees the others,
  without a second search.
- **Its values rank higher**: weight 3, like tags, instead of 2. A sibling
  value names what a group of notes is about, so a query matching it is a
  strong signal.

Matching details:

- Values match case-insensitively (`Alice Smith` = `alice smith`).
- A list value relates notes sharing any one item: a note with
  `author: [Alice Smith, Bob Jones]` is a sibling of every note by either
  author.
- Siblings are listed most recent first. A search result lists at most 10
  related notes in total. `qkb get` lists up to 50 siblings per field.

**Choose fields where a value is shared by a handful of notes, not
hundreds.** `source` and `series` are good sibling fields. `status: done` or
`author: <you>` on every note are not: every note would be a sibling of every
other, and the related list would stop meaning anything.

No field is a sibling field unless you declare it. `source` is only a
convention.

## Related notes

Each search result, and each `qkb get`, lists related notes in this order:

1. `links_to`: notes this note links to, in the order the links appear.
2. `linked_from`: notes that link to this one (backlinks).
3. `sibling`: notes sharing a sibling-field value, field by field in the
   order the fields are declared.

A note appears only once, under its first relation. Links resolve within the
note's own vault, by file name, vault path, title or alias. A link to a note
that doesn't exist yet starts resolving once that note is indexed.

## How results are ranked

`qkb query` (and the MCP `qkb` tool) run hybrid search:

```
query ──► keyword search (BM25) ─┐
      └─► semantic search (vectors) ─┴─► fusion (RRF) ─► [rerank] ─► results
[expand] adds keyword/semantic searches for rewrites of the query before fusion
```

**Keyword search** scores a note by where the query words appear. Default
weights:

| Where | Weight |
|---|---|
| title, aliases | 5 |
| headings, tags, sibling fields | 3 |
| declared fields | 2 |
| body | 1 |
| type | 0.5 |

Short fields weigh more than long ones: a word in a three-word title says
more than the same word in a long body. Tune the weights in
`[search.fts_weights]`; `0` makes a field unsearchable.

**Semantic search** compares the query's embedding with each chunk's
embedding (chunk text plus the note's declared-field lines), so a note can
match without sharing a word with the query.

**Fusion** (Reciprocal Rank Fusion) combines the two ranked lists by
position, not by raw score. A note ranked high by both comes first.

**Reranking** (optional, `--rerank`): a local cross-encoder model reads the
query together with each of the top 30 candidates (title, declared fields and
best-matching passage) and scores how well the note answers the query. The
final order blends that score with the fusion rank, trusting the fusion rank
more at the top. A confident reranker can lift a deep hit, but it can't bury
an exact title match.

**Query expansion** (optional, `--expand`): a small local model rewrites
the query into a few variants: other keywords, and paraphrases or a
hypothetical answer. Their searches are fused in, with the original query
counting double. This helps short or vaguely worded queries.

Both optional stages run on your machine. They download their models on
first use and fall back to plain search if the model fails. Turn them on for
every search with `[rerank] enabled = true` / `[expansion] enabled = true`.

## Filtering

Filters narrow the candidates before ranking. They are combined with AND.

| Filter | CLI | MCP |
|---|---|---|
| type | `--type meeting` | `type` |
| tags | `--tags work,ops` (all must match) | `tags` |
| date range | `--date-from 2026-01-01 --date-to 2026-03-31` | `date_from`, `date_to` |
| vault | `--vault Personal` (repeatable) | `vaults` |
| any stored property | `--field company=Acme` (repeatable) | `fields: {"company": "Acme"}` |

`--field` works on every stored property, declared or not. It matches
case-insensitively, and a list property matches if any item matches.

## When a config change takes effect

| Change | Takes effect |
|---|---|
| declare a field, or edit a declared value in a note | next `ingest`; the affected notes re-embed on the next `embed` |
| mark a field `siblings = true` | related notes: immediately. Ranking weight: next `ingest` |
| a description | immediately (next MCP server start for agents) |
| `[search.fts_weights]` | immediately |
| `[rerank]`, `[expansion]` | immediately |
| embedding model or provider | `qkb embed --full` |
| upgrading from qkb 0.5 or earlier | the index is reset automatically; run `qkb ingest && qkb embed` |

With `qkb mcp --watch` or `qkb watch` running, the `ingest` and `embed` steps
happen on their own.

## Example configuration

A vault with web clips, meeting notes and project notes (synthetic values):

```toml
[vault]
path = "~/Documents/Notes"
name = "Notes"

[frontmatter.fields]
source   = { description = "Where a note came from: a web page URL, a meeting, a book", siblings = true }
series   = { description = "Recurring meeting or publication a note belongs to", siblings = true }
project  = "Project this note is part of, e.g. homelab-traefik"
company  = "Employer or client the note is about"
attendees = "People present in a meeting"

[rerank]
enabled = true
```

A note from that vault:

```yaml
---
id: 7d3e1c52-8a41-4f0e-9b6a-2f1d9c0e4a11
title: Traefik cert renewal
aliases: [TLS renewal]
tags: [homelab, networking]
created: 2026-03-15T10:00:00-06:00
source: 2026-03-15-infra-sync
project: homelab-traefik
attendees: [Alice Smith, Bob Jones]
---
```

Searching `tls renewal` finds it through the alias (weight 5). Its result
lists the other notes from the `2026-03-15-infra-sync` meeting as siblings.
An agent reading `qkb_status` sees that `project` exists and has the value
`homelab-traefik`, and can filter on it.
