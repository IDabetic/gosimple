/**
 * Embedding providers for semantic matching.
 *
 * Two providers ship, and the difference between them matters enough that the
 * language reports which one is active rather than hiding it:
 *
 *   `local`  — deterministic character-trigram hashing. No network, no API
 *              key, no cost. It captures morphological and orthographic
 *              similarity, so "svećica" and "svecicama" land close together
 *              and survive Cyrillic/Latin mixing. It does NOT understand
 *              meaning: it will not connect "mali porodični auto koji malo
 *              troši" to a listing for an economical hatchback.
 *
 *   `openai` — real sentence embeddings. Understands meaning, costs money,
 *              needs a key, and introduces a network dependency on the
 *              indexing path.
 *
 * Calling the local provider "semantic search" would be a lie, so the engine
 * labels its results `lexical-vector` and the remote one `semantic`.
 */

import { createHash } from 'node:crypto';
import { normalize, stem, tokenizeText } from './text.ts';

export type EmbeddingKind = 'lexical-vector' | 'semantic';

export interface EmbeddingProvider {
  readonly name: string;
  readonly kind: EmbeddingKind;
  readonly dimensions: number;
  /** Embeds a batch. Implementations must preserve input order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Cosine similarity for L2-normalized vectors, clamped to [0, 1]. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  // Negative similarity is not meaningful for retrieval scoring.
  return Math.max(0, Math.min(1, dot));
}

function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / norm;
  return vector;
}

/**
 * Hashes a feature into a bucket, with a sign derived from a second hash.
 * Signed hashing keeps unrelated collisions from systematically inflating
 * similarity, which unsigned bucketing does.
 */
function hashFeature(feature: string, dimensions: number): { index: number; sign: number } {
  const digest = createHash('sha256').update(feature).digest();
  const index = digest.readUInt32BE(0) % dimensions;
  const sign = (digest[4]! & 1) === 0 ? 1 : -1;
  return { index, sign };
}

/**
 * Local provider: character trigrams plus whole stemmed words.
 *
 * Trigrams give robustness to inflection and typos; whole words keep exact
 * matches strongly weighted. Both go through the same normalization the
 * lexical path uses, so Cyrillic and Latin input produce identical vectors.
 */
export class LocalEmbedding implements EmbeddingProvider {
  readonly name = 'local';
  readonly kind: EmbeddingKind = 'lexical-vector';
  readonly dimensions: number;

  constructor(dimensions = 256) {
    this.dimensions = dimensions;
  }

  private embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const tokens = tokenizeText(text);

    for (const token of tokens) {
      // Whole stemmed word, weighted above its fragments.
      const { index, sign } = hashFeature(`w:${stem(token)}`, this.dimensions);
      vector[index] = vector[index]! + sign * 2;

      // Character trigrams with boundary markers.
      const padded = `^${normalize(token)}$`;
      for (let i = 0; i + 3 <= padded.length; i++) {
        const gram = padded.slice(i, i + 3);
        const h = hashFeature(`g:${gram}`, this.dimensions);
        vector[h.index] = vector[h.index]! + h.sign;
      }
    }

    return l2Normalize(vector);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }
}

export type OpenAIEmbeddingOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Requests per batch. The API rejects very large batches. */
  batchSize?: number;
  timeoutMs?: number;
};

/**
 * OpenAI-compatible embeddings.
 *
 * Works against any endpoint implementing `/v1/embeddings`, including local
 * servers such as Ollama or LM Studio, so a self-hosted model is a base URL
 * change rather than a code change.
 */
export class OpenAIEmbedding implements EmbeddingProvider {
  readonly name: string;
  readonly kind: EmbeddingKind = 'semantic';
  readonly dimensions: number;

  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private batchSize: number;
  private timeoutMs: number;

  constructor(options: OpenAIEmbeddingOptions) {
    if (!options.apiKey) {
      throw new Error('OpenAI embedding zahteva API ključ.');
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'text-embedding-3-small';
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.batchSize = options.batchSize ?? 128;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.dimensions = this.model.includes('3-large') ? 3072 : 1536;
    this.name = `openai:${this.model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];

    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ model: this.model, input: batch }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(
            `Embedding API je vratio ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
          );
        }

        const payload = (await response.json()) as {
          data?: Array<{ embedding: number[]; index: number }>;
        };
        if (!payload.data || payload.data.length !== batch.length) {
          throw new Error('Embedding API je vratio neočekivan broj vektora.');
        }

        // The API may reorder; `index` is authoritative.
        const ordered = [...payload.data].sort((a, b) => a.index - b.index);
        for (const item of ordered) {
          out.push(l2Normalize(Float32Array.from(item.embedding)));
        }
      } finally {
        clearTimeout(timer);
      }
    }

    return out;
  }
}

/**
 * Builds a provider from environment configuration.
 *
 * GOSIMPLE_EMBEDDING=local|openai   (default: local)
 * GOSIMPLE_EMBEDDING_MODEL=...
 * GOSIMPLE_EMBEDDING_BASE_URL=...   (for self-hosted OpenAI-compatible servers)
 * OPENAI_API_KEY=...
 */
export function createEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const kind = (env.GOSIMPLE_EMBEDDING ?? 'local').toLowerCase();

  if (kind === 'local') return new LocalEmbedding();

  if (kind === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GOSIMPLE_EMBEDDING=openai je postavljeno, ali OPENAI_API_KEY nedostaje.',
      );
    }
    const options: OpenAIEmbeddingOptions = { apiKey };
    if (env.GOSIMPLE_EMBEDDING_MODEL) options.model = env.GOSIMPLE_EMBEDDING_MODEL;
    if (env.GOSIMPLE_EMBEDDING_BASE_URL) options.baseUrl = env.GOSIMPLE_EMBEDDING_BASE_URL;
    return new OpenAIEmbedding(options);
  }

  throw new Error(`Nepoznat embedding provajder "${kind}". Dostupno: local, openai.`);
}
