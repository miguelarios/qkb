/**
 * Deterministic offline provider for tests and CI.
 *
 * Ported from `legacy/python/src/qkb/embed/fake.py`.
 */
import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./types.js";

export class FakeProvider implements EmbeddingProvider {
  private readonly _dim: number;

  constructor(dimension = 8) {
    this._dim = dimension;
  }

  get dimension(): number {
    return this._dim;
  }

  get modelName(): string {
    return `fake-${this._dim}d`;
  }

  private vector(text: string): number[] {
    let raw = Buffer.alloc(0);
    let counter = 0;
    while (raw.length < this._dim * 4) {
      raw = Buffer.concat([raw, createHash("sha256").update(`${counter}:${text}`).digest()]);
      counter++;
    }
    const vals: number[] = [];
    for (let i = 0; i < this._dim; i++) {
      vals.push(raw.readInt32BE(i * 4));
    }
    const norm = Math.sqrt(vals.reduce((sum, v) => sum + v * v, 0)) || 1.0;
    return vals.map((v) => v / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.vector(query);
  }
}
