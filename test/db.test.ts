import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connect,
  placeholders,
  rebuildVectorTable,
  vectorTableDimension,
} from "../src/db/schema.js";

// Ports legacy/python/tests/test_db.py — schema fidelity to db.py is what the
// golden-query scores depend on (see .superpowers/sdd/ts-task-3-brief.md).
describe("db/schema", () => {
  let tmpDir: string;
  let dbs: Database.Database[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-db-test-"));
  });

  afterEach(() => {
    for (const db of dbs) {
      db.close();
    }
    dbs = [];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function open(dbPath: string, dim: number): Database.Database {
    const db = connect(dbPath, dim);
    dbs.push(db);
    return db;
  }

  describe("test_schema_created", () => {
    it("creates every table (and creates the parent dir if missing)", () => {
      // Python's tmp_path / "sub" / "qkb.db": "sub" doesn't exist yet, proving
      // connect() creates parent directories for real paths.
      const db = open(join(tmpDir, "sub", "qkb.db"), 8);
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        .all() as { name: string }[];
      const names = new Set(rows.map((r) => r.name));
      for (const t of [
        "documents",
        "documents_fts",
        "chunks",
        "chunks_vec",
        "tags",
        "metadata",
        "context_descriptions",
        "embedding_config",
      ]) {
        expect(names.has(t), t).toBe(true);
      }
    });
  });

  describe("test_connect_idempotent", () => {
    it("second connect on an existing DB does not fail on existing DDL", () => {
      const p = join(tmpDir, "qkb.db");
      connect(p, 8).close();
      const db = open(p, 8);
      db.prepare("SELECT 1").get();
    });
  });

  describe("test_vector_roundtrip", () => {
    it("inserts an embedding and finds it back via MATCH KNN", () => {
      const db = open(":memory:", 4);
      db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)").run(
        1n,
        new Float32Array([0.1, 0.2, 0.3, 0.4]),
      );
      const row = db
        .prepare("SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 1")
        .get(new Float32Array([0.1, 0.2, 0.3, 0.4])) as { chunk_id: number; distance: number };
      expect(row.chunk_id).toBe(1);
    });
  });

  describe("test_rebuild_vector_table_changes_dimension", () => {
    it("drops and recreates chunks_vec at the new dimension", () => {
      const db = open(":memory:", 4);
      rebuildVectorTable(db, 8);

      // a 4-dim insert must now fail
      expect(() =>
        db
          .prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)")
          .run(1n, new Float32Array([0.1, 0.2, 0.3, 0.4])),
      ).toThrow();

      // an 8-dim insert must succeed and be searchable
      db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)").run(
        2n,
        new Float32Array(8).fill(0.1),
      );
      const row = db
        .prepare("SELECT chunk_id FROM chunks_vec WHERE embedding MATCH ? AND k = 1")
        .get(new Float32Array(8).fill(0.1)) as { chunk_id: number };
      expect(row.chunk_id).toBe(2);
    });
  });

  describe("test_vector_table_dimension_reads_created_dimension", () => {
    it("reads the dimension back from the stored DDL", () => {
      const db = open(":memory:", 8);
      expect(vectorTableDimension(db)).toBe(8);

      rebuildVectorTable(db, 16);
      expect(vectorTableDimension(db)).toBe(16);
    });
  });

  describe("test_vector_table_dimension_none_when_table_missing", () => {
    it("returns null when chunks_vec doesn't exist", () => {
      const db = open(":memory:", 8);
      db.exec("DROP TABLE chunks_vec");
      expect(vectorTableDimension(db)).toBeNull();
    });
  });

  describe("test_placeholders", () => {
    it("builds a ?,?,... placeholder string", () => {
      expect(placeholders(3)).toBe("?,?,?");
      expect(placeholders(1)).toBe("?");
      expect(placeholders(0)).toBe("");
    });
  });
});
