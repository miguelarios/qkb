/**
 * Local embeddings via the Ollama HTTP API (`/api/embed`).
 *
 * Ported from `legacy/python/src/qkb/embed/ollama.py`. Python holds a
 * persistent `httpx.Client`; this uses the global `fetch` per request
 * (Node/undici pool connections transparently), so there's no client
 * object to construct or close.
 */
import { applyTemplate, defaultFormats, validatedTemplate } from "./templates.js";
import type { EmbeddingProvider } from "./types.js";

const BATCH = 32;

export interface OllamaProviderOptions {
  /** Explicit `{t}`-placeholder prompt templates (e.g. from
   * `[embedding] doc_template`/`query_template` config). When either is
   * unset, the per-model `defaultFormats(model)` heuristic is used for
   * that slot — so a custom model tag (that the heuristic doesn't
   * recognize) can still get correct task-prefixed prompts via config. */
  docTemplate?: string | null;
  queryTemplate?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class OllamaProvider implements EmbeddingProvider {
  private readonly _host: string;
  private readonly _model: string;
  private readonly _dim: number;
  private readonly _docFmt: string;
  private readonly _queryFmt: string;
  private readonly _fetch: typeof fetch;

  constructor(host: string, model: string, dimension: number, options: OllamaProviderOptions = {}) {
    this._host = host;
    this._model = model;
    this._dim = dimension;
    const [defaultDocFmt, defaultQueryFmt] = defaultFormats(model);
    this._docFmt = validatedTemplate("doc_template", options.docTemplate ?? null) ?? defaultDocFmt;
    this._queryFmt =
      validatedTemplate("query_template", options.queryTemplate ?? null) ?? defaultQueryFmt;
    this._fetch = options.fetchImpl ?? fetch;
  }

  get dimension(): number {
    return this._dim;
  }

  get modelName(): string {
    return this._model;
  }

  /** Exposed for tests (mirrors Python tests reading `p._doc_fmt` directly
   * in the same package). */
  get docFormat(): string {
    return this._docFmt;
  }

  get queryFormat(): string {
    return this._queryFmt;
  }

  private async embedRaw(inputs: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += BATCH) {
      const batch = inputs.slice(i, i + BATCH);
      let resp: Response;
      try {
        resp = await this._fetch(`${this._host}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this._model, input: batch }),
        });
      } catch (e) {
        throw new Error(
          `Ollama embed failed (${e}). Is Ollama running and is '${this._model}' pulled? (ollama pull ${this._model})`,
        );
      }
      if (!resp.ok) {
        throw new Error(
          `Ollama embed failed (HTTP ${resp.status}). Is Ollama running and is '${this._model}' pulled? (ollama pull ${this._model})`,
        );
      }
      const data = (await resp.json()) as { embeddings: number[][] };
      for (const v of data.embeddings) {
        if (v.length !== this._dim) {
          throw new Error(
            `Model '${this._model}' returned dimension ${v.length}, config says ${this._dim}. Fix [embedding].dimension.`,
          );
        }
      }
      out.push(...data.embeddings);
    }
    return out;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.embedRaw(texts.map((t) => applyTemplate(this._docFmt, t)));
  }

  async embedQuery(query: string): Promise<number[]> {
    const vectors = await this.embedRaw([applyTemplate(this._queryFmt, query)]);
    const [v] = vectors;
    if (v === undefined) {
      throw new Error("embedQuery: no vector returned");
    }
    return v;
  }
}
