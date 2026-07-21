/**
 * Per-model prompt templates shared by embedding providers.
 *
 * Asymmetric embedding models need different task prefixes for documents vs
 * queries. All providers format prompts through these helpers so a vault
 * indexed by one provider uses the same prompt shapes as another.
 *
 * Ported from `legacy/python/src/qkb/embed/templates.py`.
 */

/** (docTemplate, queryTemplate) with a `{t}` placeholder. */
export function defaultFormats(model: string): [string, string] {
  if (model.startsWith("embeddinggemma")) {
    return ["title: none | text: {t}", "task: search result | query: {t}"];
  }
  if (model.startsWith("nomic")) {
    return ["search_document: {t}", "search_query: {t}"];
  }
  return ["{t}", "{t}"];
}

/**
 * Renders `template` substituting `{t}` with `text`. Supports `{{`/`}}` as
 * literal-brace escapes, mirroring Python's `str.format`. Throws if the
 * template references any field other than `t`, or has an unbalanced brace.
 */
export function applyTemplate(template: string, text: string): string {
  let result = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "{") {
      if (template[i + 1] === "{") {
        result += "{";
        i += 2;
        continue;
      }
      const end = template.indexOf("}", i);
      if (end === -1) {
        throw new Error("Single '{' encountered in format string");
      }
      const field = template.slice(i + 1, end);
      if (field !== "t") {
        throw new Error(`'${field}' is not a valid format field`);
      }
      result += text;
      i = end + 1;
      continue;
    }
    if (ch === "}") {
      if (template[i + 1] === "}") {
        result += "}";
        i += 2;
        continue;
      }
      throw new Error("Single '}' encountered in format string");
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Validates a user-supplied `doc_template`/`query_template` config override.
 * `name` (e.g. `"doc_template"`) is used to name the offending setting in
 * the thrown error. Returns `null` unchanged so callers can `??` in a
 * per-model default.
 */
export function validatedTemplate(name: string, template: string | null): string | null {
  if (template === null) {
    return null;
  }
  if (!template.includes("{t}")) {
    throw new Error(`${name} must contain a {t} placeholder, got ${JSON.stringify(template)}`);
  }
  try {
    applyTemplate(template, "");
  } catch (e) {
    throw new Error(
      `${name} has an invalid format template ${JSON.stringify(template)}: only the {t} placeholder is allowed (${e})`,
    );
  }
  return template;
}
