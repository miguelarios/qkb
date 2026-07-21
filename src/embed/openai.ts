/**
 * Embeddings via an OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * New module — no Python original (the legacy provider only shipped
 * fastembed/gguf/ollama). Mirrors embed/ollama.ts's structure, dimension
 * check, and error style per the task brief. Supports OpenAI itself and
 * compatible local servers (LM Studio, llamafile, vLLM) via `baseUrl`. The
 * API key comes from `QKB_OPENAI_API_KEY` (never written to the TOML
 * config — see src/config.ts) and is sent as `Authorization: Bearer`.
 */
import { applyTemplate, defaultFormats, validatedTemplate } from "./templates.js";
import type { EmbeddingProvider } from "./types.js";

const BATCH = 32;

export interface OpenAIProviderOptions {
  docTemplate?: string | null;
  queryTemplate?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface EmbeddingsResponse {
  data: { embedding: number[]; index: number }[];
}

export class OpenAIProvider implements EmbeddingProvider {
  private readonly _baseUrl: string;
  private readonly _apiKey: string | null;
  private readonly _model: string;
  private readonly _dim: number;
  private readonly _docFmt: string;
  private readonly _queryFmt: string;
  private readonly _fetch: typeof fetch;

  constructor(
    baseUrl: string,
    apiKey: string | null,
    model: string,
    dimension: number,
    options: OpenAIProviderOptions = {},
  ) {
    this._baseUrl = baseUrl;
    this._apiKey = apiKey;
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
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this._apiKey) {
        headers.authorization = `Bearer ${this._apiKey}`;
      }
      let resp: Response;
      try {
        resp = await this._fetch(`${this._baseUrl}/v1/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: this._model, input: batch }),
        });
      } catch (e) {
        throw new Error(
          `OpenAI embed failed (${e}). Check QKB_OPENAI_API_KEY and that '${this._model}' is available at ${this._baseUrl}.`,
        );
      }
      if (!resp.ok) {
        throw new Error(
          `OpenAI embed failed (HTTP ${resp.status}). Check QKB_OPENAI_API_KEY and that '${this._model}' is available at ${this._baseUrl}.`,
        );
      }
      const data = (await resp.json()) as EmbeddingsResponse;
      const vectors = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      for (const v of vectors) {
        if (v.length !== this._dim) {
          throw new Error(
            `Model '${this._model}' returned dimension ${v.length}, config says ${this._dim}. Fix [embedding].dimension.`,
          );
        }
      }
      out.push(...vectors);
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
