import type { ParsedNote } from "../../src/types.js";

/** Fixture overrides may still say `context` / `source`: since #35 those are
 * ordinary frontmatter properties, so they land in `extraMetadata` (where a
 * real note's frontmatter lands too) and filters match them there. */
export type NoteOverrides = Partial<ParsedNote> & {
  context?: string | null;
  source?: string | null;
};

export function withProps(
  base: ParsedNote,
  overrides: NoteOverrides,
  defaults: { context?: string | null; source?: string | null } = {},
): ParsedNote {
  const {
    context = defaults.context ?? null,
    source = defaults.source ?? null,
    ...rest
  } = overrides;
  const merged: ParsedNote = { ...base, ...rest };
  const extra = { ...merged.extraMetadata };
  if (context !== null && context !== undefined) extra.context = context;
  if (source !== null && source !== undefined) extra.source = source;
  return { ...merged, extraMetadata: extra };
}
