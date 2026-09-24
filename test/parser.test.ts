import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FRONTMATTER } from "../src/config.js";
import { parseDateLenient, parseNote } from "../src/ingest/parser.js";

// Ports legacy/python/tests/test_parser.py — the parser's opt-in/reject
// decisions and error classification feed the ingestion pipeline's deletion
// sweep (Task 8), so behavior must be byte-equivalent to the Python source.
describe("ingest/parser", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-parser-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const FM: Record<string, string[]> = Object.fromEntries(
    Object.entries(DEFAULT_FRONTMATTER).map(([k, v]) => [k, [...v]]),
  );

  function note(name: string, frontmatter: string, body = "Hello world."): string {
    const p = join(tmpDir, name);
    writeFileSync(p, `---\n${frontmatter}\n---\n\n${body}\n`);
    return p;
  }

  describe("parseDateLenient", () => {
    it("parses a bare date", () => {
      expect(parseDateLenient("2026-03-15")).toBe("2026-03-15");
    });

    it("parses an ISO datetime with offset, taking the date part", () => {
      expect(parseDateLenient("2026-01-08T13:50:19-06:00")).toBe("2026-01-08");
    });

    it("accepts a native Date defensively (never produced by the CORE_SCHEMA yaml engine)", () => {
      expect(parseDateLenient(new Date(Date.UTC(2026, 2, 15)))).toBe("2026-03-15");
    });

    it("rejects an unexpanded Templater placeholder", () => {
      expect(parseDateLenient("<% tp.date.now() %>")).toBeNull();
    });

    it("rejects an empty string", () => {
      expect(parseDateLenient("")).toBeNull();
    });

    it("rejects null/undefined", () => {
      expect(parseDateLenient(null)).toBeNull();
      expect(parseDateLenient(undefined)).toBeNull();
    });

    // Review finding 1: ISO_DATE_RE over-accepts out-of-range clock fields
    // that Python's `datetime.fromisoformat` rejects with ValueError.
    it("rejects an out-of-range hour/minute/second (Python raises ValueError)", () => {
      expect(parseDateLenient("2026-03-15T99:99:99")).toBeNull();
      expect(parseDateLenient("2026-03-15T13:61:00")).toBeNull();
      expect(parseDateLenient("2026-03-15T24:00:00")).toBeNull();
    });

    it("rejects an offset whose magnitude is 24h or more", () => {
      expect(parseDateLenient("2026-03-15T13:50:19+24:00")).toBeNull();
      expect(parseDateLenient("2026-03-15T13:50:19+99:00")).toBeNull();
    });

    it("rejects year 0000 (Python's MINYEAR is 1)", () => {
      expect(parseDateLenient("0000-01-01")).toBeNull();
    });

    // Review finding 1: ISO_DATE_RE under-accepts formats Python's
    // `datetime.fromisoformat` (3.11+) does accept.
    it("accepts basic-format date (no dashes)", () => {
      expect(parseDateLenient("20260315")).toBe("2026-03-15");
    });

    it("accepts hour-only time", () => {
      expect(parseDateLenient("2026-03-15T13")).toBe("2026-03-15");
    });

    it("accepts a comma decimal separator for fractional seconds", () => {
      expect(parseDateLenient("2026-03-15T13:50:19,123456")).toBe("2026-03-15");
    });

    it("accepts a 2-digit (hour-only) UTC offset", () => {
      expect(parseDateLenient("2026-03-15T13:50:19+06")).toBe("2026-03-15");
    });

    it("accepts basic-format time (no colons)", () => {
      expect(parseDateLenient("2026-03-15T135019")).toBe("2026-03-15");
    });

    it("accepts a bare 'Z' UTC suffix", () => {
      expect(parseDateLenient("2026-03-15T13:50:19Z")).toBe("2026-03-15");
    });

    it("accepts a seconds-bearing offset", () => {
      expect(parseDateLenient("2026-03-15T13:50:19+06:00:30")).toBe("2026-03-15");
    });

    it("accepts any single character as the date/time separator", () => {
      expect(parseDateLenient("2026-03-15_13:50:19")).toBe("2026-03-15");
    });

    // Review finding 2, residual gap 2: PyYAML's implicit timestamp resolver
    // (narrower/more lenient than fromisoformat in a different way - see
    // matchYamlTimestamp) accepts single-digit month/day/hour when a time
    // part is present, and auto-parses the value into a datetime *before*
    // parser.py's parse_date_lenient ever runs its string branch. A
    // date-only value with single-digit fields is NOT auto-parsed by PyYAML
    // (its date-only branch requires 2-digit month/day) and both Python and
    // this port correctly reject it - no change there.
    it("accepts single-digit month/day/hour when a time part is present (PyYAML resolver shape)", () => {
      expect(parseDateLenient("2026-3-16 9:00:00")).toBe("2026-03-16");
    });

    it("still rejects single-digit month/day with no time part", () => {
      expect(parseDateLenient("2026-3-16")).toBeNull();
    });
  });

  it("parses a fully-populated note", () => {
    const p = note(
      "a.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d401\n" +
        "type: transcript\n" +
        "title: Project Kickoff\n" +
        "aliases: [Kickoff, Launch meeting]\n" +
        "context: Acme-Corp-PM-Role\n" +
        "source: 2026-03-15-project-kickoff\n" +
        "created: 2026-03-16T09:00:00-06:00\n" +
        "date: 2026-03-15\n" +
        "tags: [meeting, '#kickoff']\n" +
        "attendee: Alice Smith",
      "# Agenda\n\nSee [[Roadmap#Q3|the roadmap]] and ![[diagram.png]].\n\n## Decisions\n",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.effectiveDate).toBe("2026-03-15"); // date > created
    expect(n?.createdAt).toBe("2026-03-16T09:00:00-06:00");
    expect(n?.tags).toEqual(["meeting", "kickoff"]); // leading # dropped
    expect(n?.aliases).toEqual(["Kickoff", "Launch meeting"]);
    expect(n?.headings).toEqual(["Agenda", "Decisions"]);
    expect(n?.links).toEqual(["Roadmap", "diagram.png"]);
    // context/source are ordinary properties now (#35)
    expect(n?.extraMetadata).toEqual({
      context: "Acme-Corp-PM-Role",
      source: "2026-03-15-project-kickoff",
      attendee: "Alice Smith",
    });
    expect(n?.title).toBe("Project Kickoff");
    expect(n?.filePath).toBe("a.md");
  });

  it("indexes a note with an id and nothing else (#33)", () => {
    const p = note("b.md", "id: f47ac10b-58cc-4372-a567-0e02b2c3d402");
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.title).toBe("b");
    expect(n?.type).toBe("note");
  });

  it("does not index a note without an id — returns null, never throws (#33)", () => {
    const p = note("no-id.md", "context: homelab\ncreated: 2026-01-01T00:00:00-06:00");
    expect(parseNote(p, tmpDir, FM)).toBeNull();
    const bare = join(tmpDir, "bare.md");
    writeFileSync(bare, "Just text, no frontmatter.\n");
    expect(parseNote(bare, tmpDir, FM)).toBeNull();
  });

  it("falls back to the file's modification time when no date property parses (#33)", () => {
    const p = note(
      "no-date.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d40a\ndate: <% tp.date.now() %>",
    );
    const when = new Date("2025-06-01T12:34:56Z");
    utimesSync(p, when, when);
    const n = parseNote(p, tmpDir, FM);
    expect(n?.effectiveDate).toBe("2025-06-01");
    expect(n?.createdAt).toBe("2025-06-01T12:34:56.000Z");
  });

  it("uses `modified` when neither date nor created is present", () => {
    const p = note("m.md", "id: f47ac10b-58cc-4372-a567-0e02b2c3d40b\nmodified: 2026-04-02");
    expect(parseNote(p, tmpDir, FM)?.effectiveDate).toBe("2026-04-02");
  });

  it("ignores headings and links inside fenced code blocks", () => {
    const p = note(
      "code.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d40d",
      "# Real\n\n```md\n# Not a heading\n[[Not a link]]\n```\n\n~~~\n## Also not\n~~~\n\n[[Real link]]\n",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n?.headings).toEqual(["Real"]);
    expect(n?.links).toEqual(["Real link"]);
  });

  it("a declared field is picked up from any property, including context", () => {
    const p = note(
      "f.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d40e\ncontext: homelab\ncompany: Acme",
    );
    const n = parseNote(p, tmpDir, FM, ["context", "company"]);
    expect(n?.fields).toEqual({ context: "homelab", company: "Acme" });
  });

  it("falls back to the legacy 'date created' key and filename for title", () => {
    const p = note(
      "My Note.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d404\n" + "date created: 2025-09-27T10:31:30-05:00",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.effectiveDate).toBe("2025-09-27");
    expect(n?.title).toBe("My Note"); // filename fallback
    expect(n?.type).toBe("note"); // default type
  });

  it("falls back to created when date field is unparseable", () => {
    const p = note(
      "d.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d405\n" +
        "date: <% tp.date.now() %>\n" +
        "created: 2026-02-02T08:00:00-06:00",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.effectiveDate).toBe("2026-02-02");
  });

  it("falls through a broken created to the legacy alias", () => {
    // Finding 7: a present-but-unparseable `created` must not shadow a valid
    // `date created` alias. No `date` key present, so effectiveDate and
    // createdAt both come from the legacy alias.
    const p = note(
      "f.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d407\n" +
        "created: <% tp.date.now() %>\n" +
        "date created: 2026-07-01",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.effectiveDate).toBe("2026-07-01");
    expect(n?.createdAt).toBe("2026-07-01");
    expect(n?.extraMetadata).not.toHaveProperty("created");
    expect(n?.extraMetadata).not.toHaveProperty("date created");
  });

  it("falls back createdAt to the effective date when no created alias parses", () => {
    // Finding 7: when no `created` alias parses, createdAt must fall back to
    // the effective date's ISO string, never the raw unparseable value.
    const p = note(
      "g.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d408\n" +
        "date: 2026-06-01\n" +
        "created: <% tp.date.now() %>",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.effectiveDate).toBe("2026-06-01");
    expect(n?.createdAt).toBe("2026-06-01");
    expect(n?.extraMetadata).not.toHaveProperty("created");
  });

  it("prefers a valid created over the legacy alias (alias order preserved)", () => {
    // Regression: when `created` itself parses, it wins over `date created`
    // (alias order preserved) and createdAt reflects it.
    const p = note(
      "h.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d409\n" +
        "created: 2026-02-02T08:00:00-06:00\n" +
        "date created: 2020-01-01",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.effectiveDate).toBe("2026-02-02");
    expect(n?.createdAt).toBe("2026-02-02T08:00:00-06:00");
  });

  it("canonicalizes a space-separated created timestamp to use 'T' (Finding 2)", () => {
    // Python's PyYAML SafeLoader auto-parses this shape into a datetime, and
    // `.isoformat()` always renders "T" - even though the frontmatter used a
    // space. gray-matter's CORE_SCHEMA keeps it a raw string (intentional -
    // see parser.ts), so the parser must canonicalize the separator itself.
    const p = note(
      "space-sep.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d40d\n" + "created: 2026-03-16 09:00:00-06:00",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.createdAt).toBe("2026-03-16T09:00:00-06:00");
  });

  it("does not canonicalize a created value with no time component", () => {
    // Regression guard: a date-only `created` value (no hour/min/sec) is
    // never auto-parsed by PyYAML into a datetime with a "T", so it must
    // pass through unchanged.
    const p = note(
      "date-only-created.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d40e\n" + "context: homelab\n" + "created: 2026-03-16",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.createdAt).toBe("2026-03-16");
  });

  // Review finding 2, residual gap 1: Python builds a datetime via PyYAML's
  // implicit timestamp resolver and calls `.isoformat()`, which normalizes
  // the offset representation (Z -> +00:00, short offsets get zero-padded
  // and colonized) - not just the separator.
  it("normalizes a 'Z' suffix to '+00:00' (T-separated)", () => {
    const p = note(
      "z-suffix-t.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d410\n" + "created: 2026-03-16T09:00:00Z",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.createdAt).toBe("2026-03-16T09:00:00+00:00");
  });

  it("normalizes a 'Z' suffix to '+00:00' (space-separated)", () => {
    const p = note(
      "z-suffix-space.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d411\n" + "created: 2026-03-16 09:00:00Z",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.createdAt).toBe("2026-03-16T09:00:00+00:00");
  });

  it("zero-pads and colonizes a short (hour-only) offset", () => {
    const p = note(
      "short-offset.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d412\n" + "created: 2026-03-16T09:00:00-06",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.createdAt).toBe("2026-03-16T09:00:00-06:00");
  });

  it("zero-pads a single-digit offset hour", () => {
    const p = note(
      "single-digit-offset.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d413\n" + "created: 2026-03-16T09:00:00+6:00",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.createdAt).toBe("2026-03-16T09:00:00+06:00");
  });

  it("renders fractional seconds the way Python's isoformat would (padded to 6 digits)", () => {
    const p = note(
      "fraction.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d414\n" + "created: 2026-03-16T09:00:00.5",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.createdAt).toBe("2026-03-16T09:00:00.500000");
  });

  it("leaves a naive (no-offset) timestamp with 'T' already unchanged", () => {
    const p = note(
      "naive.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d415\n" + "created: 2026-03-16T09:00:00",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.createdAt).toBe("2026-03-16T09:00:00");
  });

  // Review finding 2, residual gap 2: single-digit month/day/hour with a
  // time part must still resolve to an effective date and a canonicalized
  // createdAt, matching PyYAML's more lenient (for this one grammar) resolver.
  it("resolves single-digit month/day/hour with a time part (PyYAML resolver shape)", () => {
    const p = note(
      "single-digit-with-time.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d416\n" + "created: 2026-3-16 9:00:00",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.effectiveDate).toBe("2026-03-16");
    expect(n?.createdAt).toBe("2026-03-16T09:00:00");
  });

  it("honors a remapped alias key from the frontmatter map", () => {
    const fm: Record<string, string[]> = Object.fromEntries(
      Object.entries(DEFAULT_FRONTMATTER).map(([k, v]) => [k, [...v]]),
    );
    fm.id = ["uuid"];
    const p = note("e.md", "uuid: f47ac10b-58cc-4372-a567-0e02b2c3d406\ncreated: 2026-01-01");
    const n = parseNote(p, tmpDir, fm);
    expect(n?.id).toBe("f47ac10b-58cc-4372-a567-0e02b2c3d406");
  });

  it("does not mis-parse a '---' delimiter inside a fenced code block in the body", () => {
    // Fenced example uses a key ("fenced_example_key") that isn't one of the
    // CORE_KEYS aliases: if gray-matter mis-parsed the fence as a second
    // frontmatter block, this key (and the fence's "context: fake") would
    // surface in extraMetadata.
    const p = note(
      "fenced.md",
      "id: f47ac10b-58cc-4372-a567-0e02b2c3d40c\nstatus: real\ncreated: 2026-01-01T00:00:00-06:00",
      "Here is an example frontmatter block:\n\n" +
        "```yaml\n---\ncontext: fake\nfenced_example_key: fenced_example_value\n---\n```\n\n" +
        "More body text after the fence.",
    );
    const n = parseNote(p, tmpDir, FM);
    expect(n).not.toBeNull();
    expect(n?.extraMetadata).toEqual({ status: "real" }); // nothing from the fence
    expect(n?.body).toContain(
      "```yaml\n---\ncontext: fake\nfenced_example_key: fenced_example_value\n---\n```",
    );
    expect(n?.body).toContain("More body text after the fence.");
    expect(n?.extraMetadata).not.toHaveProperty("fenced_example_key");
  });
});
