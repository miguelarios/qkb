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
