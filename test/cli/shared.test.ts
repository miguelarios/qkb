import { describe, expect, it } from "vitest";
import {
  clipAtWordBoundary,
  matchAttribution,
  relativeScorePercents,
} from "../../src/cli/shared.js";
import type { HydratedResult } from "../../src/search/hydrate.js";

// Pure formatting/decision helpers only — the table/evidence-line printing
// around them is covered end-to-end by the subprocess tests in
// test/cli.test.ts (see its "human search output" describe block), same
// split as test/cli/progress.test.ts.

function result(overrides: Partial<HydratedResult> = {}): HydratedResult {
  return {
    document_id: "f47ac10b-58cc-4372-a567-0e02b2c3d401",
    title: "Alice's traefik notes",
    type: "note",
    context: "homelab-traefik",
    context_description: null,
    source: null,
    effective_date: "2026-01-01",
    score: 1,
    file_path: "a.md",
    obsidian_uri: "obsidian://open?vault=x&file=a",
    matched_text: null,
    tags: [],
    siblings: [],
    ...overrides,
  };
}

describe("relativeScorePercents", () => {
  it("scores the top result 100% and others proportionally, rounded", () => {
    const rows = [result({ score: 7.2081 }), result({ score: 3.6 }), result({ score: 1.8 })];
    expect(relativeScorePercents(rows)).toEqual([100, 50, 25]);
  });

  it("handles a single result", () => {
    expect(relativeScorePercents([result({ score: 0.000123 })])).toEqual([100]);
  });

  it("clamps a negative (dissimilar) vector score to 0%, never negative", () => {
    // score = 1 - cosine_distance (vector.ts); a poor match can go negative
    // while the top result stays positive.
    const rows = [result({ score: 0.8 }), result({ score: -0.4 })];
    expect(relativeScorePercents(rows)).toEqual([100, 0]);
  });

  it("clamps rounding overshoot at 100% for a near-tie just above top", () => {
    const rows = [result({ score: 1.0 }), result({ score: 1.004 })];
    // 1.004/1.0 rounds to 100 already, but this pins the clamp exists even
    // if float error nudged a "tied" second result fractionally above top.
    expect(relativeScorePercents(rows)[1]).toBeLessThanOrEqual(100);
  });

  it("falls back to binary 100/0 when the top score is zero", () => {
    const rows = [result({ score: 0 }), result({ score: 0 }), result({ score: -1 })];
    expect(relativeScorePercents(rows)).toEqual([100, 100, 0]);
  });

  it("falls back to binary 100/0 when the top score is negative", () => {
    const rows = [result({ score: -0.1 }), result({ score: -0.5 })];
    expect(relativeScorePercents(rows)).toEqual([100, 0]);
  });
});

describe("matchAttribution", () => {
  it("attributes a title hit", () => {
    const r = result({ title: "Traefik cert renewal", context: "homelab" });
    expect(matchAttribution(r, "traefik")).toBe('matched: title "Traefik cert renewal"');
  });

  it("attributes a context hit when the query is exactly a context name", () => {
    const r = result({ title: "Unrelated note title", context: "homelab-traefik" });
    expect(matchAttribution(r, "homelab-traefik")).toBe('matched: context "homelab-traefik"');
  });

  it("attributes a tag hit", () => {
    const r = result({ title: "Notes", context: "homelab", tags: ["reverse-proxy", "infra"] });
    expect(matchAttribution(r, "reverse-proxy")).toBe('matched: tag "reverse-proxy"');
  });

  it("attributes a type hit when nothing else matches", () => {
    const r = result({ title: "Notes", context: "homelab", type: "meeting", tags: [] });
    expect(matchAttribution(r, "meeting")).toBe('matched: type "meeting"');
  });

  it("is case-insensitive", () => {
    const r = result({ title: "Notes", context: "Homelab-Traefik" });
    expect(matchAttribution(r, "HOMELAB-TRAEFIK")).toBe('matched: context "Homelab-Traefik"');
  });

  it("prefers title over context/tag/type when multiple fields match", () => {
    const r = result({ title: "traefik notes", context: "traefik", tags: ["traefik"] });
    expect(matchAttribution(r, "traefik")).toBe('matched: title "traefik notes"');
  });

  it("returns null when no field is identifiable", () => {
    const r = result({ title: "Notes", context: "homelab", type: "note", tags: [] });
    expect(matchAttribution(r, "traefik")).toBeNull();
  });

  it("returns null for a query with no word tokens", () => {
    const r = result();
    expect(matchAttribution(r, "!!!")).toBeNull();
  });
});

describe("clipAtWordBoundary", () => {
  it("returns short text unchanged", () => {
    expect(clipAtWordBoundary("short text", 80)).toBe("short text");
  });

  it("clips at the nearest word boundary, never mid-word, with a trailing …", () => {
    const text = "Renewing traefik certificates for the homelab reverse proxy setup";
    const clipped = clipAtWordBoundary(text, 30);
    expect(clipped.length).toBeLessThanOrEqual(30);
    expect(clipped.endsWith("…")).toBe(true);
    const withoutEllipsis = clipped.slice(0, -1);
    // The text right before the ellipsis must be a WHOLE prefix of the
    // original (i.e. followed by a space or the string's end there) —
    // never a partial word like "traef…".
    expect(text.startsWith(withoutEllipsis)).toBe(true);
    const nextChar = text[withoutEllipsis.length];
    expect(nextChar === undefined || nextChar === " ").toBe(true);
  });

  it("collapses internal whitespace/newlines before clipping", () => {
    expect(clipAtWordBoundary("a\n\n  b   c", 80)).toBe("a b c");
  });

  it("falls back to a hard cut when there is no space to break on", () => {
    const clipped = clipAtWordBoundary("supercalifragilisticexpialidocious", 10);
    expect(clipped).toBe("supercali…");
  });
});
