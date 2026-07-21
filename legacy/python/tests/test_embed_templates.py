"""Shared per-model prompt templates used by all embedding providers."""

import pytest

from qkb.embed.templates import default_formats, validated_template


def test_embeddinggemma_formats():
    doc, query = default_formats("embeddinggemma")
    assert doc == "title: none | text: {t}"
    assert query == "task: search result | query: {t}"


def test_embeddinggemma_gguf_stem_matches_prefix_heuristic():
    # The local provider derives model names from GGUF file stems; the
    # startswith() heuristic must still recognize them.
    doc, query = default_formats("embeddinggemma-300M-Q8_0")
    assert doc == "title: none | text: {t}"
    assert query == "task: search result | query: {t}"


def test_nomic_formats():
    assert default_formats("nomic-embed-text") == ("search_document: {t}", "search_query: {t}")


def test_unknown_model_passthrough():
    assert default_formats("mystery-model") == ("{t}", "{t}")


def test_validated_template_accepts_valid():
    assert validated_template("doc_template", "prefix: {t}") == "prefix: {t}"


def test_validated_template_none_passthrough():
    assert validated_template("doc_template", None) is None


def test_validated_template_rejects_missing_placeholder():
    with pytest.raises(ValueError, match="doc_template"):
        validated_template("doc_template", "no placeholder here")


def test_validated_template_rejects_foreign_tokens():
    with pytest.raises(ValueError, match="query_template"):
        validated_template("query_template", "{t} | {context}")
