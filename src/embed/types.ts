/**
 * The embedding provider interface (plan §7). Ported from
 * `legacy/python/src/qkb/embed/base.py`'s `EmbeddingProvider` Protocol.
 * Lives in its own module so every provider can implement it without a
 * circular import through `provider.ts` (which also imports every
 * provider for `getProvider` dispatch).
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
  readonly dimension: number;
  readonly modelName: string;
  close?(): void;
}
