import { describe, expect, it } from "vitest";
import { buildFilterClause, Filters } from "../src/search/filters.js";

// Ports legacy/python/tests/test_filters.py — exact SQL and parameter
// semantics, including context normalization via normalizeContext,
// source stripping (no lowercase), tags AND-semantics via junction table,
// date range expansion and validation.

describe("search/filters", () => {
  describe("buildFilterClause", () => {
    it("empty filters return no-op clause", () => {
      const [clause, params] = buildFilterClause(new Filters());
      expect(clause).toBe("1=1");
      expect(params).toEqual([]);
    });

    it("all fields generates all conditions", () => {
      const [clause, params] = buildFilterClause(
        new Filters({
          context: "Homelab ",
          docType: "note",
          tags: ["a", "b"],
          dateFrom: "2026-01-01",
          dateTo: "2026-12-31",
          source: "s1",
        }),
      );
      expect(clause).toContain("d.context = ?");
      expect(clause).toContain("d.type = ?");
      expect(clause).toContain("d.source = ?");
      expect(clause).toContain("d.effective_date >= ?");
      expect(clause).toContain("d.effective_date <= ?");
      expect(clause).toContain("HAVING COUNT(DISTINCT tag) = ?");
      expect(params[0]).toBe("homelab"); // context normalized
      expect(params[params.length - 1]).toBe(2); // tag count
    });

    it("context uses shared normalizer", () => {
      const [clause, params] = buildFilterClause(new Filters({ context: "  Homelab  " }));
      expect(clause).toContain("d.context = ?");
      expect(params[0]).toBe("homelab");
    });

    it("context whitespace-only raises", () => {
      expect(() => buildFilterClause(new Filters({ context: "   " }))).toThrow(/context/);
    });

    it("context none produces no clause", () => {
      const [clause, params] = buildFilterClause(new Filters({ context: undefined }));
      expect(clause).not.toContain("d.context = ?");
      expect(params).toEqual([]);
    });

    it("source is stripped", () => {
      const [clause, params] = buildFilterClause(new Filters({ source: " foo " }));
      expect(clause).toContain("d.source = ?");
      expect(params[0]).toBe("foo");
    });

    it("source whitespace-only raises", () => {
      expect(() => buildFilterClause(new Filters({ source: "   " }))).toThrow(/source/);
    });

    it("source none produces no clause", () => {
      const [clause, params] = buildFilterClause(new Filters({ source: undefined }));
      expect(clause).not.toContain("d.source = ?");
      expect(params).toEqual([]);
    });

    it("source not case folded", () => {
      const [_clause, params] = buildFilterClause(new Filters({ source: " MixedCase-Source " }));
      expect(params[0]).toBe("MixedCase-Source");
    });

    it("docType empty string produces no clause", () => {
      const [clause, params] = buildFilterClause(new Filters({ docType: "" }));
      expect(clause).not.toContain("d.type = ?");
      expect(params).toEqual([]);
    });

    it("docType none produces no clause", () => {
      const [clause, params] = buildFilterClause(new Filters({ docType: undefined }));
      expect(clause).not.toContain("d.type = ?");
      expect(params).toEqual([]);
    });

    it("tags empty array produces no clause", () => {
      const [clause, params] = buildFilterClause(new Filters({ tags: [] }));
      expect(clause).not.toContain("HAVING COUNT(DISTINCT tag)");
      expect(params).toEqual([]);
    });

    it("date_from normalizes datetime to canonical date", () => {
      const [clause, params] = buildFilterClause(new Filters({ dateFrom: "2026-07-07T10:00:00" }));
      expect(clause).toContain("d.effective_date >= ?");
      expect(params[0]).toBe("2026-07-07");
    });

    it("date_to normalizes datetime to canonical date", () => {
      const [clause, params] = buildFilterClause(new Filters({ dateTo: "2026-07-07T23:59:59" }));
      expect(clause).toContain("d.effective_date <= ?");
      expect(params[0]).toBe("2026-07-07");
    });

    it("unparseable date_from raises", () => {
      expect(() => buildFilterClause(new Filters({ dateFrom: "2026-7-7" }))).toThrow(/date_from/);
    });

    it("unparseable date_to raises", () => {
      expect(() => buildFilterClause(new Filters({ dateTo: "2026-7-7" }))).toThrow(/date_to/);
    });

    it("date_from year expands to first day", () => {
      const [clause, params] = buildFilterClause(new Filters({ dateFrom: "2026" }));
      expect(clause).toContain("d.effective_date >= ?");
      expect(params[0]).toBe("2026-01-01");
    });

    it("date_to year expands to last day", () => {
      const [clause, params] = buildFilterClause(new Filters({ dateTo: "2026" }));
      expect(clause).toContain("d.effective_date <= ?");
      expect(params[0]).toBe("2026-12-31");
    });

    it("date_from year-month expands to first day", () => {
      const [_clause, params] = buildFilterClause(new Filters({ dateFrom: "2026-02" }));
      expect(params[0]).toBe("2026-02-01");
    });

    it("date_to year-month expands to last day non-leap February", () => {
      // 2026 is not a leap year
      const [_clause, params] = buildFilterClause(new Filters({ dateTo: "2026-02" }));
      expect(params[0]).toBe("2026-02-28");
    });

    it("date full ISO passes through", () => {
      const [_clause, params] = buildFilterClause(new Filters({ dateFrom: "2026-03-15" }));
      expect(params[0]).toBe("2026-03-15");
    });

    it("date_from year-month out of range raises", () => {
      expect(() => buildFilterClause(new Filters({ dateFrom: "2026-13" }))).toThrow(/date_from/);
    });

    it("date garbage raises", () => {
      expect(() => buildFilterClause(new Filters({ dateFrom: "garbage" }))).toThrow(/date_from/);
    });

    it("date_from whitespace-only raises", () => {
      expect(() => buildFilterClause(new Filters({ dateFrom: "   " }))).toThrow(/date_from/);
    });

    it("date_to empty string raises", () => {
      expect(() => buildFilterClause(new Filters({ dateTo: "" }))).toThrow(/date_to/);
    });

    it("date bounds none still unfiltered", () => {
      const [clause, params] = buildFilterClause(
        new Filters({ dateFrom: undefined, dateTo: undefined }),
      );
      expect(clause).toBe("1=1");
      expect(params).toEqual([]);
    });
  });
});
