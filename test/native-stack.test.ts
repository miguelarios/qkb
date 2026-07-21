import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

// Proves the native stack actually installs and works together on this
// platform: better-sqlite3 bundles its own SQLite (with extension loading
// enabled), which sqlite-vec needs — the system sqlite3 on macOS is built
// with SQLITE_OMIT_LOAD_EXTENSION and cannot load it. See
// docs/plans/2026-07-20-typescript-rewrite.md §2/§11.
describe("native stack: better-sqlite3 + sqlite-vec", () => {
  it("loads the sqlite-vec extension into an in-memory database", () => {
    const db = new Database(":memory:");
    try {
      sqliteVec.load(db);

      const row = db.prepare("select vec_version() as version").get() as { version: string };
      expect(row.version).toMatch(/^v\d+\.\d+\.\d+/);
    } finally {
      db.close();
    }
  });

  it("creates a vec0 virtual table and runs a KNN query", () => {
    const db = new Database(":memory:");
    try {
      sqliteVec.load(db);
      db.exec("CREATE VIRTUAL TABLE vec_smoke USING vec0(embedding float[3])");
      const insert = db.prepare("INSERT INTO vec_smoke (rowid, embedding) VALUES (?, ?)");
      insert.run(1n, new Float32Array([1, 0, 0]));
      insert.run(2n, new Float32Array([0, 1, 0]));

      const results = db
        .prepare(
          "SELECT rowid, distance FROM vec_smoke WHERE embedding MATCH ? AND k = 1 ORDER BY distance",
        )
        .all(new Float32Array([1, 0, 0])) as { rowid: number; distance: number }[];

      expect(results).toHaveLength(1);
      expect(results[0]?.rowid).toBe(1);
    } finally {
      db.close();
    }
  });
});
