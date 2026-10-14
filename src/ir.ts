/**
 * GoSimple intermediate representation.
 *
 * The IR is the stable contract between the compiler and the runtime. It is
 * plain JSON so a plan can be cached, diffed, shipped to another process, and
 * version-checked independently of the surface syntax.
 *
 * Bump IR_VERSION on any breaking shape change; the runtime refuses plans it
 * does not understand rather than guessing.
 */

import type { Season } from './ast.ts';

export const IR_VERSION = 1;

/** Ranking signals the runtime knows how to compute. */
export const RANK_SIGNALS = [
  'query_relevance',
  'semantic_similarity',
  'category_match',
  'seasonal_relevance',
  'popularity',
  'freshness',
  'user_interest',
  'purchase_intent',
  'content_quality',
  'originality',
  'price_fit',
] as const;

export type RankSignal = (typeof RANK_SIGNALS)[number];

/**
 * Signals that describe *when* rather than *what*. These are the only ones a
 * locked intent suppresses.
 *
 * Popularity is deliberately not in this list. It can only drag a result
 * across category lines, and intent protection already filters competing
 * categories out, so within a locked category popularity stays a useful
 * ordering signal. Season is different: it actively argues for a *different*
 * category, which is precisely what a locked intent must override.
 */
export const CONTEXTUAL_SIGNALS: readonly RankSignal[] = ['seasonal_relevance'];

export const MATCH_FIELDS = ['keywords', 'category', 'semantic'] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

export const DIVERSIFY_FIELDS = ['category', 'brand', 'vendor'] as const;

export const LEARN_EVENTS = ['views', 'clicks', 'add_to_cart', 'purchases', 'saved_items', 'dismissals'] as const;
export const ANALYZE_CHECKS = ['ai_patterns', 'naturalness', 'specificity', 'duplication', 'completeness'] as const;

export type IRCategory = {
  name: string;
  terms: string[];
  signals: string[];
  seasons: Season[];
};

export type IRIntentRule = {
  name: string;
  whenSignalOf: string;
  thenCategory: string;
  confidence: number;
  lock: boolean;
};

export type IRIntent = {
  name: string;
  rules: IRIntentRule[];
  ambiguousBelow: number;
};

export type IRSearch = {
  retrieve: number;
  match: Array<{ field: MatchField; weight: number }>;
  rank: Array<{ signal: RankSignal; weight: number }>;
  protectIntent: boolean;
  diversify: { field: string; max: number } | null;
  excludeUnavailable: boolean;
  explain: boolean;
  topN: number;
};

/**
 * Factors a recommendation score can be built from.
 *
 * `collaborative` and `content` need either user history or a seed item, so
 * a cold-start request cannot use them. Their weight is redistributed over
 * the factors that remain, the same way suppressed rank signals are handled
 * in search — so a cold slate and a warm slate stay on the same scale.
 */
export const RECOMMEND_FACTORS = [
  'collaborative',
  'content',
  'season',
  'popularity',
  'interests',
  'price',
] as const;

export type RecommendFactor = (typeof RECOMMEND_FACTORS)[number];

/** Factors that produce nothing without user history or a seed item. */
export const HISTORY_DEPENDENT_FACTORS: readonly RecommendFactor[] = ['collaborative', 'content'];

/** Used when a factor is enabled through `account for` rather than `factors`. */
export const DEFAULT_FACTOR_WEIGHTS: Record<RecommendFactor, number> = {
  collaborative: 0.45,
  content: 0.2,
  season: 0.15,
  popularity: 0.1,
  interests: 0.1,
  price: 0.1,
};

export type IRRecommend = {
  learnFrom: string[];
  /** Resolved weights, whether declared explicitly or defaulted. */
  factors: Partial<Record<RecommendFactor, number>>;
  /** Share of the slate reserved for categories outside the user's history. */
  explore: number;
  excludeRecentlySeen: boolean;
  topN: number;
};

export type IRContent = {
  analyze: string[];
  scores: string[];
};

/** Document fields a source may be mapped onto. */
export const DOC_FIELDS = [
  'id', 'title', 'description', 'category', 'brand', 'vendor',
  'price', 'available', 'views', 'purchases', 'createdAt', 'tags',
] as const;

/** Fields without which a document cannot participate in search. */
export const REQUIRED_DOC_FIELDS = ['id', 'title', 'category'] as const;

export type IRSource = {
  name: string;
  uri: string;
  table: string | null;
  columns: Record<string, string>;
  where: string | null;
  limit: number | null;
};

export type Plan = {
  irVersion: number;
  engine: string;
  source: IRSource;
  /** Behavioural event log. Required by the recommend block. */
  events: { uri: string } | null;
  categories: IRCategory[];
  intent: IRIntent | null;
  search: IRSearch | null;
  recommend: IRRecommend | null;
  content: IRContent | null;
  /**
   * Precomputed inverted indexes. Building them at compile time turns
   * per-query term lookup from a scan over all categories into a map hit.
   */
  indexes: {
    /** normalized term -> categories that claim it (length > 1 means ambiguous) */
    termToCategories: Record<string, string[]>;
    /** normalized signal word -> category it disambiguates to */
    signalToCategory: Record<string, string>;
    /** season -> categories boosted in that season */
    seasonToCategories: Record<string, string[]>;
  };
};
