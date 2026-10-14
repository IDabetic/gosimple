/**
 * Plan executor.
 *
 * Takes a compiled IR plan plus a document set and produces ranked, explained
 * results. Execution is deterministic: given the same plan, documents, query
 * and `now`, the output is byte-identical. That property is what makes
 * ranking changes reviewable and regressions reproducible.
 */

import { CONTEXTUAL_SIGNALS, type Plan, type RankSignal } from '../ir.ts';
import { analyzeContent, type ContentReport } from './content.ts';
import { DuplicationIndex } from './duplication.ts';
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

/** What a {@link Engine.reload} actually did. */
export type CatalogChange = {
  added: number;
  updated: number;
  removed: number;
};

/**
 * Whether a reload can skip this document.
 *
 * Compares the whole document rather than a list of fields. An enumeration
 * here would have to be extended every time `Doc` grows, and the failure
 * mode of forgetting is silent: the index keeps serving the old value and
 * nothing in the output says so. Serializing is a little wasteful and
 * cannot be wrong in that direction.
 */
function sameDoc(current: Doc | undefined, incoming: Doc): boolean {
  if (!current) return false;
  return JSON.stringify(current) === JSON.stringify(incoming);
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
  private docsById = new Map<string, Doc>();
  private docTokens = new Map<string, Set<string>>();
  /**
   * token -> document ids. Lets the match phase skip the catalogue.
   *
   * Keyed by id rather than by position so that removing one product does
   * not shift every posting after it. The catalogue of a live shop changes.
   */
  private tokenPostings = new Map<string, Set<string>>();
  private scanAllDocuments: boolean;
  /** category -> document ids, for the `category` match field. */
  private categoryPostings = new Map<string, Set<string>>();
  /** Corpus-relative duplication, maintained across catalogue changes. */
  private duplication: DuplicationIndex | null = null;
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

    // Content analysis is corpus-relative: a document's originality depends
    // on its neighbours, so it cannot be computed per document on demand.
    if (plan.content || plan.search?.rank.some((r) => r.signal === 'content_quality' || r.signal === 'originality')) {
      this.duplication = new DuplicationIndex();
    }

    this.ingest(docs, []);
  }

  /**
   * Applies catalogue changes without rebuilding the engine.
   *
   * `upserts` are added or replaced by id, `removals` are dropped. Returns
   * what actually changed, which is not the same as what was asked for: an
   * upsert of an unchanged document is a no-op, and removing something that
   * was never there is not an error.
   *
   * Vectors are the caller's concern via {@link reload}; this method keeps
   * everything that can be derived synchronously.
   */
  private ingest(upserts: Doc[], removals: string[]): { added: number; updated: number; removed: number } {
    let added = 0;
    let updated = 0;
    let removed = 0;

    for (const id of removals) {
      if (this.forget(id)) removed++;
    }

    const contentChanges: Array<{ id: string; text: string }> = [];

    for (const doc of upserts) {
      if (this.docsById.has(doc.id)) {
        this.forget(doc.id);
        updated++;
      } else {
        added++;
      }

      this.docsById.set(doc.id, doc);

      const tokens = new Set(tokenizeText(docText(doc)).map(stem));
      this.docTokens.set(doc.id, tokens);

      for (const token of tokens) {
        const postings = this.tokenPostings.get(token);
        if (postings) postings.add(doc.id);
        else this.tokenPostings.set(token, new Set([doc.id]));
      }

      const byCategory = this.categoryPostings.get(doc.category);
      if (byCategory) byCategory.add(doc.id);
      else this.categoryPostings.set(doc.category, new Set([doc.id]));

      if (this.duplication) contentChanges.push({ id: doc.id, text: doc.description ?? doc.title });
    }

    if (this.duplication) {
      this.duplication.apply(contentChanges, removals);
      // Duplication is the only part of the content report that depends on
      // the rest of the catalogue, and `apply` may have changed it for
      // documents nobody touched. Re-deriving the reports whose number moved
      // is cheaper than re-reading every description.
      this.refreshContentReports();
    }

    this.refreshMaxima();

    return { added, updated, removed };
  }

  /** Drops one document from every index. Returns false if it was absent. */
  private forget(id: string): boolean {
    const doc = this.docsById.get(id);
    if (!doc) return false;

    for (const token of this.docTokens.get(id) ?? []) {
      const postings = this.tokenPostings.get(token);
      if (!postings) continue;
      postings.delete(id);
      if (postings.size === 0) this.tokenPostings.delete(token);
    }

    const byCategory = this.categoryPostings.get(doc.category);
    if (byCategory) {
      byCategory.delete(id);
      if (byCategory.size === 0) this.categoryPostings.delete(doc.category);
    }

    this.docsById.delete(id);
    this.docTokens.delete(id);
    this.contentReports.delete(id);
    this.docVectors.delete(id);
    return true;
  }

  private refreshContentReports(): void {
    if (!this.duplication) return;
    for (const doc of this.docsById.values()) {
      const text = doc.description ?? doc.title;
      const score = this.duplication.scoreOf(doc.id);
      const current = this.contentReports.get(doc.id);
      // Only the duplication input can have moved; everything else in the
      // report is a function of the text alone.
      if (current && Math.abs(1 - current.originality - score) < 1e-9) continue;
      this.contentReports.set(doc.id, analyzeContent(text, score));
    }
  }

  /**
   * Recomputes popularity denominators.
   *
   * Maxima can fall as well as rise, so they cannot be folded in one
   * document at a time: removing the single most-viewed product has to
   * rescale popularity for everything else.
   */
  private refreshMaxima(): void {
    this.maxViews = 1;
    this.maxPurchases = 1;
    for (const doc of this.docsById.values()) {
      this.maxViews = Math.max(this.maxViews, doc.views ?? 0);
      this.maxPurchases = Math.max(this.maxPurchases, doc.purchases ?? 0);
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
    if (this.scanAllDocuments) return this.allDocs();

    const search = this.plan.search!;
    const weightOf = (field: string): number =>
      search.match.find((m) => m.field === field)?.weight ?? 0;

    if (weightOf('semantic') > 0) return this.allDocs();

    const picked = new Set<string>();

    if (weightOf('keywords') > 0) {
      for (const token of queryTokens) {
        const postings = this.tokenPostings.get(token);
        if (postings) for (const id of postings) picked.add(id);
      }
    }

    if (weightOf('category') > 0) {
      for (const category of intentCategories) {
        const postings = this.categoryPostings.get(category);
        if (postings) for (const id of postings) picked.add(id);
      }
    }

    // Sorted by id so the candidate list does not depend on the order in
    // which products happened to arrive. Two engines holding the same
    // catalogue answer identically whether it was loaded at once or built
    // up by reloads.
    return [...picked].sort().map((id) => this.docsById.get(id)!);
  }

  /**
   * Replaces the catalogue with a freshly loaded one, in place.
   *
   * The whole list is passed, not a patch, because that is what a source
   * can actually produce: a JSON file or a SQL query returns the catalogue
   * as it is now, and nobody keeps a changelog of it. The diff is worked
   * out here, so a shop that edits three prices pays for three documents
   * rather than for a restart.
   *
   * Everything derived incrementally is exact. Duplication, the one signal
   * that depends on the rest of the catalogue, is maintained by an index
   * that re-scores whichever documents the change could have affected.
   */
  async reload(docs: Doc[]): Promise<CatalogChange> {
    const incoming = new Map(docs.map((doc) => [doc.id, doc]));

    if (incoming.size !== docs.length) {
      const seen = new Set<string>();
      const duplicate = docs.find((doc) => !seen.add(doc.id))?.id;
      throw new Error(
        `Katalog sadrži dva dokumenta sa istim id "${duplicate}". ` +
          `Id mora da bude jedinstven, inače jedan proizvod tiho pregazi drugi.`,
      );
    }

    const removals = [...this.docsById.keys()].filter((id) => !incoming.has(id));
    const upserts = docs.filter((doc) => !sameDoc(this.docsById.get(doc.id), doc));

    const change = this.ingest(upserts, removals);

    // Vectors are the one derived value that needs the network, so they are
    // refreshed only for documents whose text actually moved.
    if (this.usesSemantic() && this.embedding) {
      const stale = upserts.filter((doc) => !this.docVectors.has(doc.id));
      if (stale.length > 0) {
        const vectors = await this.embedding.embed(stale.map((doc) => docText(doc)));
        stale.forEach((doc, index) => this.docVectors.set(doc.id, vectors[index]!));
      }
    }

    // Cached query vectors are not touched: they depend on the query text
    // and the provider, not on what is in the catalogue.
    return change;
  }

  /** Every document, in insertion order. */
  private allDocs(): Doc[] {
    return [...this.docsById.values()];
  }

  /** Number of documents currently indexed. */
  get corpusSize(): number {
    return this.docsById.size;
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

    const all = this.allDocs();
    const texts = all.map((doc) => docText(doc));
    const vectors = await this.embedding.embed(texts);

    if (vectors.length !== all.length) {
      throw new Error(
        `Embedding provajder je vratio ${vectors.length} vektora za ${all.length} dokumenata.`,
      );
    }
    all.forEach((doc, index) => this.docVectors.set(doc.id, vectors[index]!));
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
        corpusSize: this.docsById.size,
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
