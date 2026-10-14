/**
 * Offline evaluation of a ranking plan against a golden query set.
 *
 * CONTRIBUTING asks that a change to ranking be defended with numbers. Until
 * now the project had no way to produce those numbers, so "this ordering
 * feels better" was the only available argument. That is how search quality
 * rots: every individual change looks reasonable to the person making it.
 *
 * A golden set is a list of queries with human judgement attached — which
 * documents belong in the results, and which must never appear. The second
 * half matters as much as the first here. This language exists because a
 * shopper searching for spark plugs for a Subaru in December should not be
 * shown Christmas lights, and that is a statement about what must be
 * *absent*. Metrics that only reward relevance cannot express it, so this
 * module tracks forbidden hits as a first-class result and lets them fail a
 * build.
 */

import type { SearchResponse } from './runtime/execute.ts';

export type GoldenQuery = {
  query: string;
  /** Fixed clock, so a seasonal expectation stays true next month. */
  now?: string;
  season?: string;
  /** Document id -> relevance grade. Higher is better; 0 means irrelevant. */
  relevant: Record<string, number>;
  /** Documents that must not appear. A hit here is a failure, not a penalty. */
  forbidden?: string[];
  /** Why this query is in the set. Shown when it regresses. */
  note?: string;
};

export type GoldenSet = {
  name: string;
  /** Cutoff for every @k metric. */
  k: number;
  queries: GoldenQuery[];
};

export type QueryResult = {
  query: string;
  note: string | null;
  /**
   * Null when the query has no graded relevant document. A query that only
   * declares forbidden ids is a legitimate test of what must be absent, and
   * reporting 0 for it would drag the average down for no reason.
   */
  ndcg: number | null;
  precision: number | null;
  recall: number | null;
  /** Reciprocal rank of the first relevant hit; 0 when none appears. */
  reciprocalRank: number | null;
  /** Forbidden documents that appeared in the top k. */
  violations: string[];
  returned: number;
};

export type EvalReport = {
  set: string;
  k: number;
  queries: QueryResult[];
  ndcg: number | null;
  precision: number | null;
  recall: number | null;
  mrr: number | null;
  /** Total forbidden hits across the set. Any value above zero is a failure. */
  violations: number;
};

export class GoldenSetError extends Error {}

/** Validates an untrusted JSON blob into a golden set. */
export function parseGoldenSet(input: unknown, origin: string): GoldenSet {
  if (typeof input !== 'object' || input === null) {
    throw new GoldenSetError(`${origin}: očekivan je JSON objekat.`);
  }
  const raw = input as Record<string, unknown>;

  if (!Array.isArray(raw.queries) || raw.queries.length === 0) {
    throw new GoldenSetError(`${origin}: "queries" mora da bude neprazan niz.`);
  }

  const k = raw.k === undefined ? 10 : Number(raw.k);
  if (!Number.isInteger(k) || k < 1) {
    throw new GoldenSetError(`${origin}: "k" mora da bude ceo broj veći od nule, a dobijeno je ${raw.k}.`);
  }

  const queries = raw.queries.map((entry, index) => {
    const where = `${origin}: upit ${index + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      throw new GoldenSetError(`${where} nije objekat.`);
    }
    const q = entry as Record<string, unknown>;

    if (typeof q.query !== 'string') {
      throw new GoldenSetError(`${where} nema tekstualno polje "query".`);
    }

    const relevant: Record<string, number> = {};
    if (q.relevant !== undefined) {
      if (typeof q.relevant !== 'object' || q.relevant === null || Array.isArray(q.relevant)) {
        throw new GoldenSetError(`${where}: "relevant" mora da bude mapa id → ocena.`);
      }
      for (const [id, grade] of Object.entries(q.relevant as Record<string, unknown>)) {
        const value = Number(grade);
        if (!Number.isFinite(value) || value < 0) {
          throw new GoldenSetError(`${where}: ocena za "${id}" mora da bude broj ≥ 0, a dobijeno je ${grade}.`);
        }
        relevant[id] = value;
      }
    }

    const forbidden = q.forbidden === undefined ? [] : q.forbidden;
    if (!Array.isArray(forbidden) || forbidden.some((f) => typeof f !== 'string')) {
      throw new GoldenSetError(`${where}: "forbidden" mora da bude niz identifikatora.`);
    }

    if (Object.keys(relevant).length === 0 && forbidden.length === 0) {
      throw new GoldenSetError(
        `${where} ne tvrdi ništa: nema ni "relevant" ni "forbidden". Upit bez očekivanja ne može ni da prođe ni da padne.`,
      );
    }

    const overlap = forbidden.filter((id) => relevant[id as string] !== undefined && relevant[id as string]! > 0);
    if (overlap.length > 0) {
      throw new GoldenSetError(
        `${where}: ${overlap.join(', ')} je istovremeno i relevantan i zabranjen. Jedno od ta dva je greška u skupu.`,
      );
    }

    return {
      query: q.query,
      now: typeof q.now === 'string' ? q.now : undefined,
      season: typeof q.season === 'string' ? q.season : undefined,
      relevant,
      forbidden: forbidden as string[],
      note: typeof q.note === 'string' ? q.note : undefined,
    } satisfies GoldenQuery;
  });

  return {
    name: typeof raw.name === 'string' ? raw.name : origin,
    k,
    queries,
  };
}

/**
 * Discounted cumulative gain with graded relevance.
 *
 * Gain is `2^grade − 1`, so the difference between "perfect" and "acceptable"
 * is larger than the difference between "acceptable" and "wrong". That is the
 * behaviour you want from a shop: one exactly right product at the top beats
 * three vaguely related ones.
 */
function dcg(grades: number[]): number {
  let total = 0;
  for (let i = 0; i < grades.length; i++) {
    total += (2 ** grades[i]! - 1) / Math.log2(i + 2);
  }
  return total;
}

/** Scores one query's result list against its judgements. */
export function scoreQuery(golden: GoldenQuery, rankedIds: string[], k: number): QueryResult {
  const top = rankedIds.slice(0, k);
  const forbidden = new Set(golden.forbidden ?? []);
  const graded = Object.entries(golden.relevant).filter(([, grade]) => grade > 0);

  const violations = top.filter((id) => forbidden.has(id));

  if (graded.length === 0) {
    return {
      query: golden.query,
      note: golden.note ?? null,
      ndcg: null,
      precision: null,
      recall: null,
      reciprocalRank: null,
      violations,
      returned: rankedIds.length,
    };
  }

  const gradeOf = (id: string): number => golden.relevant[id] ?? 0;
  const actual = dcg(top.map(gradeOf));
  const ideal = dcg(
    graded
      .map(([, grade]) => grade)
      .sort((a, b) => b - a)
      .slice(0, k),
  );

  const hits = top.filter((id) => gradeOf(id) > 0);
  const firstHit = top.findIndex((id) => gradeOf(id) > 0);

  return {
    query: golden.query,
    note: golden.note ?? null,
    ndcg: ideal === 0 ? null : actual / ideal,
    // Divided by what was actually shown, not by k. If the shop had only
    // three results to give, judging it as though it returned five would
    // punish it for the catalogue being small rather than for ranking badly.
    precision: hits.length / Math.max(top.length, 1),
    recall: hits.length / graded.length,
    reciprocalRank: firstHit === -1 ? 0 : 1 / (firstHit + 1),
    violations,
    returned: rankedIds.length,
  };
}

/** Mean over the queries where the metric is defined. */
function meanOf(results: QueryResult[], pick: (r: QueryResult) => number | null): number | null {
  const values = results.map(pick).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export type SearchFn = (query: GoldenQuery) => Promise<SearchResponse>;

/** Runs the whole golden set and aggregates. */
export async function evaluate(set: GoldenSet, search: SearchFn): Promise<EvalReport> {
  const queries: QueryResult[] = [];

  for (const golden of set.queries) {
    const response = await search(golden);
    queries.push(scoreQuery(golden, response.hits.map((hit) => hit.id), set.k));
  }

  return {
    set: set.name,
    k: set.k,
    queries,
    ndcg: meanOf(queries, (r) => r.ndcg),
    precision: meanOf(queries, (r) => r.precision),
    recall: meanOf(queries, (r) => r.recall),
    mrr: meanOf(queries, (r) => r.reciprocalRank),
    violations: queries.reduce((sum, r) => sum + r.violations.length, 0),
  };
}
