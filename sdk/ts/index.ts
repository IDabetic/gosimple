/**
 * GoSimple TypeScript client.
 *
 * Works in Next.js route handlers and server components, Nuxt server routes,
 * and any Node or edge runtime with `fetch`.
 *
 * Call this from the server, not the browser. The runtime is meant to sit
 * behind your application, not be exposed to end users directly.
 */

export type GoSimpleUser = {
  id?: string;
  budget?: number;
  interests?: string[];
  seenIds?: string[];
};

export type SearchOptions = {
  user?: GoSimpleUser;
  /** 'prolece' | 'leto' | 'jesen' | 'zima'. Derived from the clock when omitted. */
  season?: string;
  /** ISO timestamp. Pin this in tests to make seasonal behavior deterministic. */
  now?: string;
  signal?: AbortSignal;
};

export type SignalContribution = {
  signal: string;
  raw: number;
  weight: number;
  contribution: number;
  suppressed?: string;
};

export type SearchHit = {
  id: string;
  title: string;
  category: string;
  score: number;
  signals?: SignalContribution[];
  explanation?: string;
};

export type IntentResolution = {
  category: string | null;
  confidence: number;
  locked: boolean;
  ambiguous: boolean;
  candidates: string[];
  firedRule: string | null;
  trace: string[];
};

export type SearchResponse = {
  engine: string;
  query: string;
  season: string;
  intent: IntentResolution;
  /** Non-null when the query is ambiguous: ask the user instead of guessing. */
  clarify: { question: string; options: string[] } | null;
  hits: SearchHit[];
  stats: {
    corpusSize: number;
    retrieved: number;
    filteredByIntent: number;
    filteredByAvailability: number;
    filteredByDiversity: number;
    returned: number;
    durationMs: number;
  };
};

export type RecommendOptions = {
  userId?: string;
  /** Items to recommend "more like this" from, when there is no user history. */
  seedIds?: string[];
  excludeIds?: string[];
  interests?: string[];
  budget?: number;
  season?: string;
  now?: string;
  signal?: AbortSignal;
};

export type RecommendationReason = {
  factor: string;
  detail: string;
  contribution: number;
};

export type Recommendation = {
  id: string;
  title: string;
  category: string;
  score: number;
  reasons: RecommendationReason[];
};

export type RecommendResponse = {
  engine: string;
  /**
   * 'warm' when the user has history, 'cool' when recommending from a seed
   * item, 'cold' when neither is available. Always present, so you can tell
   * the difference between a personalised slate and a popularity list.
   */
  strategy: 'warm' | 'cool' | 'cold';
  season: string;
  userHistorySize: number;
  items: Recommendation[];
  stats: {
    candidates: number;
    excludedSeen: number;
    excludedDismissed: number;
    exploration: number;
    returned: number;
    durationMs: number;
  };
};

export type ContentReport = {
  features: {
    burstiness: number;
    specificity: number;
    fillerDensity: number;
    lexicalDiversity: number;
    duplication: number;
    sentenceCount: number;
    tokenCount: number;
  };
  templateLikeness: {
    score: number;
    confidence: number;
    evidence: Array<{ feature: string; observation: string; weight: number }>;
  };
  quality: number;
  originality: number;
};

export class GoSimpleError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GoSimpleError';
    this.status = status;
  }
}

export type GoSimpleOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class GoSimple {
  private baseUrl: string;
  private token: string | undefined;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options: GoSimpleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const { signal, ...rest } = options;
    return this.request<SearchResponse>('POST', '/search', { query, ...rest }, signal);
  }

  /**
   * Recommendations for a user, a seed item, or neither.
   *
   * Check `strategy` before presenting the result: a 'cold' slate is a
   * popularity list, and labelling it "picked for you" is a lie the user
   * will eventually notice.
   */
  recommend(options: RecommendOptions = {}): Promise<RecommendResponse> {
    const { signal, ...rest } = options;
    return this.request<RecommendResponse>('POST', '/recommend', rest, signal);
  }

  /**
   * Reports measurable writing features with supporting evidence.
   * It does not determine authorship, and you should not present it as if it does.
   */
  analyzeContent(text: string, signal?: AbortSignal): Promise<ContentReport> {
    return this.request<ContentReport>('POST', '/content', { text }, signal);
  }

  health(signal?: AbortSignal): Promise<{ status: string; engine: string; documents: number }> {
    return this.request('GET', '/health', undefined, signal);
  }

  /** The compiled IR plan currently served by the runtime. */
  plan(signal?: AbortSignal): Promise<unknown> {
    return this.request('GET', '/plan', undefined, signal);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    external?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    external?.addEventListener('abort', () => controller.abort(), { once: true });

    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;

    try {
      const response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => null)) as { error?: string } | null;

      if (!response.ok) {
        throw new GoSimpleError(response.status, payload?.error ?? `HTTP ${response.status}`);
      }
      return payload as T;
    } catch (err) {
      if (err instanceof GoSimpleError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new GoSimpleError(408, `GoSimple nije odgovorio u ${this.timeoutMs} ms`);
      }
      throw new GoSimpleError(503, `GoSimple runtime nije dostupan: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
