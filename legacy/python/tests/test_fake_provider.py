import math

from qkb.embed.fake import FakeProvider


def test_deterministic_and_dimension():
    p = FakeProvider(dimension=8)
    a1, a2 = p.embed(["hello"])[0], p.embed(["hello"])[0]
    b = p.embed(["different"])[0]
    assert a1 == a2 and a1 != b and len(a1) == 8
    assert math.isclose(sum(x * x for x in a1), 1.0, rel_tol=1e-6)  # unit norm


def test_query_matches_doc_embedding_for_same_text():
    p = FakeProvider(dimension=8)
    assert p.embed_query("same text") == p.embed(["same text"])[0]
