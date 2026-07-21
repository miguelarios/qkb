from qkb.ingest.chunker import chunk_text, estimate_tokens


def test_empty_and_small():
    assert chunk_text("") == []
    chunks = chunk_text("Just one short paragraph.")
    assert len(chunks) == 1
    assert chunks[0].index == 0
    assert chunks[0].text.strip() == "Just one short paragraph."


def test_prefers_heading_boundaries():
    part_a = "word " * 380  # ~475 estimated tokens
    doc = f"# Section One\n\n{part_a}\n\n# Section Two\n\n{'more ' * 380}"
    chunks = chunk_text(doc, target_tokens=500)
    assert len(chunks) >= 2
    # The second chunk should begin at (or contain, at its start) the heading
    assert "# Section Two" in chunks[1].text.splitlines()[0] or chunks[1].text.lstrip().startswith(
        "# Section Two"
    )


def test_code_fence_not_split():
    code = "```python\n" + "x = 1\n" * 300 + "```"
    doc = f"Intro paragraph.\n\n{code}\n\nOutro paragraph."
    chunks = chunk_text(doc, target_tokens=200)
    joined_fence_chunks = [c for c in chunks if "```python" in c.text]
    # opening fence chunk must also contain the closing fence (kept whole)
    assert all(c.text.count("```") == 2 for c in joined_fence_chunks)


def test_overlap_carried():
    doc = "\n\n".join(f"Paragraph {i}. " + "filler " * 60 for i in range(12))
    chunks = chunk_text(doc, target_tokens=200, overlap_percent=15)
    assert len(chunks) >= 2
    tail = chunks[0].text[-80:].strip()
    assert tail[:40] and tail[:40] in chunks[1].text  # head of next chunk repeats tail


def test_indices_and_token_counts():
    doc = "\n\n".join("para " * 100 for _ in range(6))
    chunks = chunk_text(doc, target_tokens=150)
    assert [c.index for c in chunks] == list(range(len(chunks)))
    assert all(c.token_count == estimate_tokens(c.text) for c in chunks)
