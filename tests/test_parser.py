from datetime import date
from pathlib import Path

from qkb.config import DEFAULT_FRONTMATTER
from qkb.ingest.parser import normalize_context, parse_date_lenient, parse_note

FM = {k: list(v) for k, v in DEFAULT_FRONTMATTER.items()}


def note(tmp_path: Path, name: str, frontmatter: str, body: str = "Hello world.") -> Path:
    p = tmp_path / name
    p.write_text(f"---\n{frontmatter}\n---\n\n{body}\n")
    return p


def test_parse_date_lenient():
    assert parse_date_lenient("2026-03-15") == date(2026, 3, 15)
    assert parse_date_lenient("2026-01-08T13:50:19-06:00") == date(2026, 1, 8)
    assert parse_date_lenient(date(2026, 3, 15)) == date(2026, 3, 15)
    assert parse_date_lenient("<% tp.date.now() %>") is None
    assert parse_date_lenient("") is None
    assert parse_date_lenient(None) is None


def test_normalize_context():
    assert normalize_context(" Laundry Tips ") == "laundry tips"
    assert normalize_context("") is None
    assert normalize_context(None) is None


def test_indexable_note(tmp_path):
    p = note(
        tmp_path,
        "a.md",
        "id: f47ac10b-58cc-4372-a567-0e02b2c3d401\n"
        "type: transcript\n"
        "title: Project Kickoff\n"
        "context: Acme-Corp-PM-Role\n"
        "source: 2026-03-15-project-kickoff\n"
        "created: 2026-03-16T09:00:00-06:00\n"
        "date: 2026-03-15\n"
        "tags: [meeting, kickoff]\n"
        "attendee: Alice Smith",
    )
    n = parse_note(p, tmp_path, FM)
    assert n is not None
    assert n.effective_date == "2026-03-15"  # date > created
    assert n.created_at == "2026-03-16T09:00:00-06:00"
    assert n.context == "acme-corp-pm-role"  # normalized
    assert n.tags == ["meeting", "kickoff"]
    assert n.extra_metadata == {"attendee": "Alice Smith"}
    assert n.title == "Project Kickoff"
    assert n.file_path == "a.md"


def test_not_indexable_without_context_or_source(tmp_path):
    p = note(
        tmp_path,
        "b.md",
        "id: f47ac10b-58cc-4372-a567-0e02b2c3d402\ncreated: 2026-01-01T00:00:00-06:00",
    )
    assert parse_note(p, tmp_path, FM) is None


def test_blank_context_is_not_indexable(tmp_path):
    p = note(
        tmp_path,
        "c.md",
        "id: f47ac10b-58cc-4372-a567-0e02b2c3d403\ncontext:\ncreated: 2026-01-01T00:00:00-06:00",
    )
    assert parse_note(p, tmp_path, FM) is None


def test_legacy_created_key_and_title_fallback(tmp_path):
    p = note(
        tmp_path,
        "My Note.md",
        "id: f47ac10b-58cc-4372-a567-0e02b2c3d404\n"
        "context: homelab\n"
        "date created: 2025-09-27T10:31:30-05:00",
    )
    n = parse_note(p, tmp_path, FM)
    assert n is not None
    assert n.effective_date == "2025-09-27"
    assert n.title == "My Note"  # filename fallback
    assert n.type == "note"  # default type


def test_bad_date_field_falls_back_to_created(tmp_path):
    p = note(
        tmp_path,
        "d.md",
        "id: f47ac10b-58cc-4372-a567-0e02b2c3d405\n"
        "context: homelab\n"
        "date: <% tp.date.now() %>\n"
        "created: 2026-02-02T08:00:00-06:00",
    )
    n = parse_note(p, tmp_path, FM)
    assert n is not None
    assert n.effective_date == "2026-02-02"


def test_broken_created_falls_through_to_legacy_alias(tmp_path):
    """Finding 7: a present-but-unparseable `created` must not shadow a valid
    `date created` alias. No `date` key present, so effective_date and
    created_at both come from the legacy alias."""
    p = note(
        tmp_path,
        "f.md",
        "id: f47ac10b-58cc-4372-a567-0e02b2c3d407\n"
        "context: homelab\n"
        "created: <% tp.date.now() %>\n"
        "date created: 2026-07-01",
    )
    n = parse_note(p, tmp_path, FM)
    assert n is not None
    assert n.effective_date == "2026-07-01"
    assert n.created_at == "2026-07-01"
    assert "created" not in n.extra_metadata
    assert "date created" not in n.extra_metadata


def test_broken_created_with_valid_date_falls_back_to_effective(tmp_path):
    """Finding 7: when no `created` alias parses, created_at must fall back to
    the effective date's ISO string, never the raw unparseable value."""
    p = note(
        tmp_path,
        "g.md",
        "id: f47ac10b-58cc-4372-a567-0e02b2c3d408\n"
        "context: homelab\n"
        "date: 2026-06-01\n"
        "created: <% tp.date.now() %>",
    )
    n = parse_note(p, tmp_path, FM)
    assert n is not None
    assert n.effective_date == "2026-06-01"
    assert n.created_at == "2026-06-01"
    assert "created" not in n.extra_metadata


def test_valid_created_still_wins_over_legacy_alias(tmp_path):
    """Regression: when `created` itself parses, it wins over `date created`
    (alias order preserved) and created_at reflects it."""
    p = note(
        tmp_path,
        "h.md",
        "id: f47ac10b-58cc-4372-a567-0e02b2c3d409\n"
        "context: homelab\n"
        "created: 2026-02-02T08:00:00-06:00\n"
        "date created: 2020-01-01",
    )
    n = parse_note(p, tmp_path, FM)
    assert n is not None
    assert n.effective_date == "2026-02-02"
    assert n.created_at == "2026-02-02T08:00:00-06:00"


def test_remapped_keys(tmp_path):
    fm = {k: list(v) for k, v in DEFAULT_FRONTMATTER.items()}
    fm["context"] = ["category"]
    p = note(
        tmp_path,
        "e.md",
        "id: f47ac10b-58cc-4372-a567-0e02b2c3d406\n"
        "category: recipes\ncreated: 2026-01-01T00:00:00-06:00",
    )
    n = parse_note(p, tmp_path, fm)
    assert n is not None and n.context == "recipes"
