/**
 * Plan executor.
 *
 * Takes a compiled IR plan plus a document set and produces ranked, explained
 * results. Execution is deterministic: given the same plan, documents, query
 * and `now`, the output is byte-identical. That property is what makes
 * ranking changes reviewable and regressions reproducible.
 */

import { CONTEXTUAL_SIGNALS, type Plan, type RankSignal } from '../ir.ts';
import { analyzeCorpus, type ContentReport } from './content.ts';
import { cosineSimilarity, type EmbeddingProvider } from './embed.ts';
import { resolveIntent, seasonOf, type IntentResolution } from './intent.ts';
import { overlapScore, overlapScoreSets, stem, tokenizeText } from './text.ts';

export type Doc = {
  id: string;
  title: string;
  description?: string;
  category: string;
  brand?: string;
  vendor?: string;
  price?: number;
  available?: boolean;
  views?: number;
  purchases?: number;
  createdAt?: string;
  tags?: string[];
};

export type UserContext = {
  id?: string;
  budget?: number;
  interests?: string[];
  seenIds?: string[];
};

export type SearchRequest = {
  query: string;
  user?: UserContext;
  /** ISO timestamp. Pinning this makes seasonal behavior testable. */
  now?: string;
  /** Overrides the season derived from `now`. */
  season?: string;
};

export type SignalContribution = {
  signal: RankSignal;
  raw: number;
  weight: number;
  contribution: number;
  /** Set when `protect intent` zeroed a contextual signal. */
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

export type SearchResponse = {
  engine: string;
  query: string;
  season: string;
  /**
   * Which vector provider backed the `semantic` match field, if any. Reported
   * because `lexical-vector` and `semantic` are genuinely different
   * capabilities and silently substituting one for the other misleads.
   */
  vectorMode: 'off' | 'lexical-vector' | 'semantic';
  intent: IntentResolution;
  /** Present when the query is ambiguous and the app should ask, not guess. */
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

export class PlanVersionError extends Error {}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Text used for lexical matching, with the title counted twice. */
function docText(doc: Doc): string {
  return [doc.title, doc.title, doc.description ?? '', (doc.tags ?? []).join(' ')].join(' ');
}

export type EngineOptions = {
  /** Required only when the program uses `match { semantic }`. */
  embedding?: EmbeddingProvider;
  /** Upper bound on cached query vectors. */
  queryCacheSize?: number;
  /**
   * Scans every document in the match phase instead of using the postings
   * index. The index is supposed to produce exactly the same candidates, and
   * this switch exists so the test suite can prove it rather than assume it.
   */
  scanAllDocuments?: boolean;
};

/** Shared empty set; a document with no tokens still needs a lookup target. */
const EMPTY_TOKENS: ReadonlySet<string> = new Set<string>();

export class Engine {
  private plan: Plan;
  private docs: Doc[];
  private docTokens = new Map<string, Set<string>>();
  /** token -> positions in `docs`. Lets the match phase skip the catalogue. */
  private tokenPostings = new Map<string, number[]>();
  private scanAllDocuments: boolean;
  /** category -> positions in `docs`, for the `category` match field. */
  private categoryPostings = new Map<string, number[]>();
  private contentReports = new Map<string, ContentReport>();
  private maxViews = 1;
  private maxPurchases = 1;

  private embedding: EmbeddingProvider | null = null;
  private docVectors = new Map<string, Float32Array>();
  private queryVectors = new Map<string, Float32Array>();
  private queryCacheSize: number;

  /**
   * Builds an engine and, when the program needs them, the document vectors.
   *
   * Vector construction is async and potentially network-bound, so it cannot
   * live in a constructor. Use this factory unless the program has no
   * `semantic` match field.
   */
  static async create(plan: Plan, docs: Doc[], options: EngineOptions = {}): Promise<Engine> {
    const engine = new Engine(plan, docs, options);
    await engine.buildVectorIndex();
    return engine;
  }

  constructor(plan: Plan, docs: Doc[], options: EngineOptions = {}) {
    this.queryCacheSize = options.queryCacheSize ?? 1024;
    this.embedding = options.embedding ?? null;
    this.scanAllDocuments = options.scanAllDocuments ?? false;
    if (plan.irVersion !== 1) {
      throw new PlanVersionError(
        `Plan koristi IR verziju ${plan.irVersion}, a ovaj runtime podržava samo 1. Rekompajlirajte .gs fajl.`,
      );
    }
    this.plan = plan;
    this.docs = docs;

    docs.forEach((doc, index) => {
      const tokens = new Set(tokenizeText(docText(doc)).map(stem));
      this.docTokens.set(doc.id, tokens);

      for (const token of tokens) {
        const postings = this.tokenPostings.get(token);
        if (postings) postings.push(index);
        else this.tokenPostings.set(token, [index]);
      }

      const byCategory = this.categoryPostings.get(doc.category);
      if (byCategory) byCategory.push(index);
      else this.categoryPostings.set(doc.category, [index]);

      this.maxViews = Math.max(this.maxViews, doc.views ?? 0);
      this.maxPurchases = Math.max(this.maxPurchases, doc.purchases ?? 0);
    });

    // Content analysis is corpus-relative (duplication needs neighbours), so
    // it is computed once up front rather than per query.
    if (plan.content || plan.search?.rank.some((r) => r.signal === 'content_quality' || r.signal === 'originality')) {
      const reports = analyzeCorpus(docs.map((d) => d.description ?? d.title));
      docs.forEach((doc, index) => this.contentReports.set(doc.id, reports[index]!));
    }
  }

  /**
   * Documents that could possibly match, instead of the whole catalogue.
   *
   * This is a narrowing, not an approximation. A document only earns match
   * score from `keywords` (which requires sharing a query token) or from
   * `category` (which requires being in the intent's candidate set), so a
   * document outside both unions would score zero and be filtered out
   * anyway. `semantic` is the exception: it can relate a query to a
   * document that shares no word with it, which is the entire point of
   * having it, so an enabled semantic clause falls back to a full scan.
   */
  private candidateDocs(queryTokens: ReadonlySet<string>, intentCategories: Set<string>): Doc[] {
    if (this.scanAllDocuments) return this.docs;

    const search = this.plan.search!;
    const weightOf = (field: string): number =>
      search.match.find((m) => m.field === field)?.weight ?? 0;

    if (weightOf('semantic') > 0) return this.docs;

    const picked = new Set<number>();

    if (weightOf('keywords') > 0) {
      for (const token of queryTokens) {
        const postings = this.tokenPostings.get(token);
        if (postings) for (const index of postings) picked.add(index);
      }
    }

    if (weightOf('category') > 0) {
      for (const category of intentCategories) {
        const postings = this.categoryPostings.get(category);
        if (postings) for (const index of postings) picked.add(index);
      }
    }

    // Catalogue order, so the candidate list is identical to what the full
    // scan would have produced rather than merely equivalent as a set.
    return [...picked].sort((a, b) => a - b).map((index) => this.docs[index]!);
  }

  /** Content report for one document, or null if content analysis is not enabled. */
  contentFor(id: string): ContentReport | null {
    return this.contentReports.get(id) ?? null;
  }

  /**
   * True when the program needs vectors, whether for candidate eligibility
   * (`match { semantic }`) or for ordering (`rank by { semantic_similarity }`).
   * Checking only the match block would leave the rank signal silently zero.
   */
  private usesSemantic(): boolean {
    const search = this.plan.search;
    if (!search) return false;
    return (
      search.match.some((m) => m.field === 'semantic' && m.weight > 0) ||
      search.rank.some((r) => r.signal === 'semantic_similarity' && r.weight > 0)
    );
  }

  get vectorMode(): 'off' | 'lexical-vector' | 'semantic' {
    if (!this.usesSemantic() || !this.embedding) return 'off';
    return this.embedding.kind;
  }

  /** Embeds the corpus once. No-op when the program does not use `semantic`. */
  private async buildVectorIndex(): Promise<void> {
    if (!this.usesSemantic() || !this.embedding) return;

    const texts = this.docs.map((doc) => docText(doc));
    const vectors = await this.embedding.embed(texts);

    if (vectors.length !== this.docs.length) {
      throw new Error(
        `Embedding provajder je vratio ${vectors.length} vektora za ${this.docs.length} dokumenata.`,
      );
    }
    this.docs.forEach((doc, index) => this.docVectors.set(doc.id, vectors[index]!));
  }

  private async embedQuery(query: string): Promise<Float32Array | null> {
    if (!this.embedding || this.docVectors.size === 0) return null;

    const cached = this.queryVectors.get(query);
    if (cached) return cached;

    const [vector] = await this.embedding.embed([query]);
    if (!vector) return null;

    // Simple bounded cache: drop the oldest entry when full. Map preserves
    // insertion order, so the first key is the oldest.
    if (this.queryVectors.size >= this.queryCacheSize) {
      const oldest = this.queryVectors.keys().next().value;
      if (oldest !== undefined) this.queryVectors.delete(oldest);
    }
    this.queryVectors.set(query, vector);
    return vector;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const started = performance.now();
    const search = this.plan.search;
    if (!search) {
      throw new Error(`Engine "${this.plan.engine}" nema search blok.`);
    }

    const now = request.now ? new Date(request.now) : new Date();
    const season = request.season ?? seasonOf(now);
    const intent = resolveIntent(this.plan, request.query);

    const queryTokens = tokenizeText(request.query).map(stem);
    const queryTokenSet = new Set(queryTokens);

    // --- Candidate retrieval ---------------------------------------------
    // Matching and ranking are separate phases. The `match` block decides who
    // is eligible; the `rank` block decides the order. Without this split, a
    // document with no connection to the query still accumulates score from
    // query-independent signals like freshness and content quality, and
    // irrelevant products surface on every page.
    const intentCategories = new Set(intent.candidates);
    const queryVector = request.query ? await this.embedQuery(request.query) : null;

    const matchValue = (doc: Doc, field: string, lexical: number): number => {
      switch (field) {
        case 'keywords':
          return lexical;
        case 'category':
          if (intent.category !== null) return doc.category === intent.category ? 1 : 0;
          return intentCategories.has(doc.category) ? 0.5 : 0;
        case 'semantic': {
          if (!queryVector) return 0;
          const docVector = this.docVectors.get(doc.id);
          return docVector ? cosineSimilarity(queryVector, docVector) : 0;
        }
        default:
          return 0;
      }
    };

    let candidates = this.candidateDocs(queryTokenSet, intentCategories)
      .map((doc) => {
        const lexical = overlapScoreSets(queryTokenSet, this.docTokens.get(doc.id) ?? EMPTY_TOKENS);
        let matchScore = 0;
        for (const clause of search.match) {
          matchScore += matchValue(doc, clause.field, lexical) * clause.weight;
        }
        return { doc, lexical, matchScore };
      })
      // Eligibility, not ranking: a zero match score means the document has no
      // relationship to this query at all.
      .filter((c) => c.matchScore > 0)
      .sort((a, b) => (b.matchScore - a.matchScore) || a.doc.id.localeCompare(b.doc.id))
      .slice(0, search.retrieve);

    const retrieved = candidates.length;

    // --- Availability filter ---------------------------------------------
    let filteredByAvailability = 0;
    if (search.excludeUnavailable) {
      const before = candidates.length;
      candidates = candidates.filter((c) => c.doc.available !== false);
      filteredByAvailability = before - candidates.length;
    }

    // --- Intent protection -------------------------------------------------
    // When the intent is locked, documents from the *competing* categories are
    // removed. Categories outside the ambiguous set are left alone: they were
    // never confusable with this query, so dropping them would be overreach.
    let filteredByIntent = 0;
    const protectionActive = search.protectIntent && intent.locked && intent.category !== null;

    if (protectionActive) {
      const competing = new Set(intent.candidates.filter((c) => c !== intent.category));
      const before = candidates.length;
      const kept = candidates.filter((c) => !competing.has(c.doc.category));

      // Never filter down to nothing. An empty page is worse than a loose one.
      if (kept.length > 0) {
        candidates = kept;
        filteredByIntent = before - kept.length;
      } else {
        intent.trace.push('Zaštita namere bi uklonila sve rezultate, pa je preskočena.');
      }
    }

    // --- Weight resolution --------------------------------------------------
    // Contextual signals yield to a locked intent, and their weight is
    // redistributed across the remaining signals rather than discarded. Without
    // redistribution, locking an intent would silently shrink every score and
    // make results from locked and unlocked queries incomparable.
    const suppressed = new Set<RankSignal>();
    if (protectionActive) {
      for (const clause of search.rank) {
        if (CONTEXTUAL_SIGNALS.includes(clause.signal)) suppressed.add(clause.signal);
      }
    }

    const activeWeight = search.rank
      .filter((r) => !suppressed.has(r.signal))
      .reduce((acc, r) => acc + r.weight, 0);
    const totalWeight = search.rank.reduce((acc, r) => acc + r.weight, 0);

    if (suppressed.size > 0) {
      intent.trace.push(
        `Zaštita namere je potisnula kontekstualne signale (${[...suppressed].join(', ')}); njihova težina je preraspodeljena na preostale signale.`,
      );
    }

    const boostedCategories = new Set(this.plan.indexes.seasonToCategories[season] ?? []);

    // --- Scoring ------------------------------------------------------------
    const scored = candidates.map(({ doc, lexical }) => {
      const contributions: SignalContribution[] = [];
      let score = 0;

      for (const clause of search.rank) {
        const isSuppressed = suppressed.has(clause.signal);
        const raw = isSuppressed
          ? 0
          : this.signalValue(clause.signal, {
              doc,
              lexical,
              intent,
              season,
              boostedCategories,
              request,
              now,
              queryVector,
            });

        // Redistribute suppressed weight proportionally across active signals.
        const effectiveWeight = isSuppressed
          ? 0
          : activeWeight > 0
            ? (clause.weight / activeWeight) * totalWeight
            : 0;

        const contribution = raw * effectiveWeight;
        score += contribution;

        const entry: SignalContribution = {
          signal: clause.signal,
          raw: Number(raw.toFixed(4)),
          weight: Number(effectiveWeight.toFixed(4)),
          contribution: Number(contribution.toFixed(4)),
        };
        if (isSuppressed) {
          entry.suppressed = `Potisnuto: namera je zaključana na "${intent.category}".`;
        }
        contributions.push(entry);
      }

      const normalizedScore = totalWeight > 0 ? score / totalWeight : 0;
      return { doc, score: normalizedScore, contributions };
    });

    scored.sort((a, b) => (b.score - a.score) || a.doc.id.localeCompare(b.doc.id));

    // --- Diversification ----------------------------------------------------
    let filteredByDiversity = 0;
    let ordered = scored;
    if (search.diversify) {
      const counts = new Map<string, number>();
      const kept: typeof scored = [];
      const overflow: typeof scored = [];

      for (const item of scored) {
        const key = String((item.doc as unknown as Record<string, unknown>)[search.diversify.field] ?? 'unknown');
        const seen = counts.get(key) ?? 0;
        if (seen < search.diversify.max) {
          counts.set(key, seen + 1);
          kept.push(item);
        } else {
          overflow.push(item);
        }
      }
      filteredByDiversity = overflow.length;
      // Overflow is appended rather than dropped, so a page is never short.
      ordered = [...kept, ...overflow];
    }

    const top = ordered.slice(0, search.topN);

    const hits: SearchHit[] = top.map((item) => {
      const hit: SearchHit = {
        id: item.doc.id,
        title: item.doc.title,
        category: item.doc.category,
        score: Number(item.score.toFixed(4)),
      };
      if (search.explain) {
        hit.signals = item.contributions;
        hit.explanation = this.explain(item.doc, item.contributions, intent, season);
      }
      return hit;
    });

    const clarify =
      intent.ambiguous && intent.candidates.length > 1
        ? {
            question: `Upit "${request.query}" može da znači više stvari. Šta tražite?`,
            options: intent.candidates,
          }
        : null;

    return {
      engine: this.plan.engine,
      query: request.query,
      season,
      vectorMode: this.vectorMode,
      intent,
      clarify,
      hits,
      stats: {
        corpusSize: this.docs.length,
        retrieved,
        filteredByIntent,
        filteredByAvailability,
        filteredByDiversity,
        returned: hits.length,
        durationMs: Number((performance.now() - started).toFixed(3)),
      },
    };
  }

  private signalValue(
    signal: RankSignal,
    ctx: {
      doc: Doc;
      lexical: number;
      intent: IntentResolution;
      season: string;
      boostedCategories: Set<string>;
      request: SearchRequest;
      now: Date;
      queryVector: Float32Array | null;
    },
  ): number {
    const { doc, lexical, intent, boostedCategories, request, now, queryVector } = ctx;

    switch (signal) {
      case 'query_relevance':
        return lexical;

      case 'semantic_similarity': {
        if (!queryVector) return 0;
        const docVector = this.docVectors.get(doc.id);
        return docVector ? cosineSimilarity(queryVector, docVector) : 0;
      }

      case 'category_match': {
        if (intent.category === null) return intent.candidates.includes(doc.category) ? 0.5 : 0;
        if (doc.category === intent.category) return 1;
        return intent.candidates.includes(doc.category) ? 0.25 : 0;
      }

      case 'seasonal_relevance':
        return boostedCategories.has(doc.category) ? 1 : 0;

      case 'popularity': {
        // Log scaling keeps one viral product from flattening the rest.
        const views = doc.views ?? 0;
        return clamp01(Math.log1p(views) / Math.log1p(this.maxViews));
      }

      case 'freshness': {
        if (!doc.createdAt) return 0;
        const ageDays = (now.getTime() - new Date(doc.createdAt).getTime()) / 86_400_000;
        if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
        // Exponential decay with a 90-day half-life.
        return clamp01(Math.pow(0.5, ageDays / 90));
      }

      case 'user_interest': {
        const interests = request.user?.interests ?? [];
        if (interests.length === 0) return 0;
        const interestTokens = new Set(interests.flatMap((i) => tokenizeText(i).map(stem)));
        return overlapScoreSets(interestTokens, this.docTokens.get(doc.id) ?? EMPTY_TOKENS);
      }

      case 'purchase_intent': {
        const views = doc.views ?? 0;
        const purchases = doc.purchases ?? 0;
        if (views === 0) return 0;
        // Conversion rate, scaled so a 20% rate reaches the ceiling.
        return clamp01(purchases / views / 0.2);
      }

      case 'content_quality':
        return this.contentReports.get(doc.id)?.quality ?? 0;

      case 'originality':
        return this.contentReports.get(doc.id)?.originality ?? 0;

      case 'price_fit': {
        const budget = request.user?.budget;
        if (budget === undefined || doc.price === undefined) return 0;
        if (doc.price <= budget) return 1;
        // Decays to zero at twice the budget.
        return clamp01(1 - (doc.price - budget) / budget);
      }
    }
  }

  private explain(
    doc: Doc,
    contributions: SignalContribution[],
    intent: IntentResolution,
    season: string,
  ): string {
    const active = contributions
      .filter((c) => c.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3)
      .map((c) => `${c.signal} ${c.contribution.toFixed(3)}`);

    const parts = [`Kategorija "${doc.category}"`];
    if (active.length > 0) parts.push(`najjači signali: ${active.join(', ')}`);

    const suppressedSignals = contributions.filter((c) => c.suppressed);
    if (suppressedSignals.length > 0) {
      parts.push(
        `sezona "${season}" nije uzeta u obzir jer je namera zaključana na "${intent.category}"`,
      );
    } else if (contributions.some((c) => c.signal === 'seasonal_relevance' && c.raw > 0)) {
      parts.push(`dobio je sezonski boost za "${season}"`);
    }

    return parts.join('; ') + '.';
  }
}
