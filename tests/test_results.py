from qkb.ingest.storage import Storage
from qkb.search.results import hydrate, obsidian_uri
from tests.conftest import ingest_one, make_note

ID_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ID_N = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def test_obsidian_uri():
    uri = obsidian_uri("Notes", "02-Areas/Work/2026-03-15 Kickoff.md")
    assert uri == "obsidian://open?vault=Notes&file=02-Areas%2FWork%2F2026-03-15%20Kickoff"


def seed_siblings(conn, provider):
    ingest_one(
        conn,
        provider,
        make_note(
            id=ID_T,
            type="transcript",
            title="Kickoff Transcript",
            context="acme-corp-pm-role",
            source="2026-03-15-project-kickoff",
            file_path="02-Areas/Work/Kickoff Transcript.md",
            body="Alice Smith walked through the roadmap.",
        ),
    )
    ingest_one(
        conn,
        provider,
        make_note(
            id=ID_N,
            type="ai-notes",
            title="Kickoff Notes",
            context="acme-corp-pm-role",
            source="2026-03-15-project-kickoff",
            file_path="02-Areas/Work/Kickoff Notes.md",
            body="Decisions: roadmap approved.",
        ),
    )


def test_hydrate_with_siblings_and_description(conn, provider):
    seed_siblings(conn, provider)
    Storage(conn).set_context_description("acme-corp-pm-role", "PM work notes")
    out = hydrate(conn, [(ID_T, 0.9, "roadmap chunk")])
    assert len(out) == 1
    r = out[0]
    assert r["title"] == "Kickoff Transcript"
    assert r["context_description"] == "PM work notes"
    assert r["matched_text"] == "roadmap chunk"
    assert r["obsidian_uri"].startswith("obsidian://open?vault=Notes&file=")
    assert [s["document_id"] for s in r["siblings"]] == [ID_N]


def test_hydrate_no_source_no_siblings(conn, provider):
    ingest_one(conn, provider, make_note(id=ID_T, source=None))
    out = hydrate(conn, [(ID_T, 0.5, None)])
    assert out[0]["siblings"] == []
