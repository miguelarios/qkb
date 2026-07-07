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


ID_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
ID_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
ID_C = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
ID_MISSING = "ffffffff-ffff-4fff-8fff-ffffffffffff"


def test_hydrate_multi_doc_preserves_contract(conn, provider):
    """8d: hydrate() was refactored to batch its per-doc queries with IN-lists.
    This locks in the output contract for a multi-doc, out-of-insertion-order,
    missing-id scenario: result order matches `ranked` (skipping missing ids),
    per-doc tags/siblings/matched_text/score stay correct and independent."""
    ingest_one(
        conn,
        provider,
        make_note(
            id=ID_A,
            title="Alpha Doc",
            context="ctx-one",
            source="shared-source",
            tags=["zeta", "alpha"],
            file_path="Alpha Doc.md",
        ),
    )
    ingest_one(
        conn,
        provider,
        make_note(
            id=ID_B,
            title="Beta Doc",
            context="ctx-two",
            source="shared-source",
            tags=[],
            file_path="Beta Doc.md",
        ),
    )
    ingest_one(
        conn,
        provider,
        make_note(
            id=ID_C,
            title="Gamma Doc",
            context=None,
            source=None,
            tags=["gamma"],
            file_path="Gamma Doc.md",
        ),
    )
    Storage(conn).set_context_description("ctx-one", "First context")

    ranked = [
        (ID_C, 0.123456789, "gamma match"),
        (ID_MISSING, 0.99, "should be skipped"),
        (ID_A, 0.987654321, "alpha match"),
        (ID_B, 0.5, None),
    ]
    out = hydrate(conn, ranked)

    # Missing id skipped; order otherwise matches `ranked`.
    assert [r["document_id"] for r in out] == [ID_C, ID_A, ID_B]

    by_id = {r["document_id"]: r for r in out}

    c = by_id[ID_C]
    assert c["title"] == "Gamma Doc"
    assert c["context"] is None
    assert c["context_description"] is None
    assert c["tags"] == ["gamma"]
    assert c["siblings"] == []
    assert c["matched_text"] == "gamma match"
    assert c["score"] == round(0.123456789, 6)

    a = by_id[ID_A]
    assert a["title"] == "Alpha Doc"
    assert a["context"] == "ctx-one"
    assert a["context_description"] == "First context"
    assert a["tags"] == ["alpha", "zeta"]  # sorted
    assert [s["document_id"] for s in a["siblings"]] == [ID_B]  # sorted by title
    assert a["matched_text"] == "alpha match"
    assert a["score"] == round(0.987654321, 6)

    b = by_id[ID_B]
    assert b["title"] == "Beta Doc"
    assert b["tags"] == []
    assert [s["document_id"] for s in b["siblings"]] == [ID_A]
    assert b["matched_text"] is None
    assert b["score"] == 0.5
