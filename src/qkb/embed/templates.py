"""Per-model prompt templates shared by embedding providers.

Asymmetric embedding models need different task prefixes for documents vs
queries. Both the Ollama and local (llama.cpp) providers format prompts
through these helpers so a vault indexed by one provider uses the same
prompt shapes as the other.
"""

from __future__ import annotations


def default_formats(model: str) -> tuple[str, str]:
    """(doc_template, query_template) with {t} placeholder."""
    if model.startswith("embeddinggemma"):
        return "title: none | text: {t}", "task: search result | query: {t}"
    if model.startswith("nomic"):
        return "search_document: {t}", "search_query: {t}"
    return "{t}", "{t}"


def validated_template(name: str, template: str | None) -> str | None:
    if template is None:
        return None
    if "{t}" not in template:
        raise ValueError(f"{name} must contain a {{t}} placeholder, got {template!r}")
    try:
        template.format(t="")
    except (KeyError, IndexError, ValueError) as e:
        raise ValueError(
            f"{name} has an invalid format template {template!r}: only the "
            f"{{t}} placeholder is allowed ({e!r})"
        ) from e
    return template
