/**
 * GoSimple abstract syntax tree.
 *
 * Every node carries a source span so the checker and runtime can point back
 * at the exact line that produced a diagnostic or a ranking decision.
 */

export type Span = { line: number; col: number };

export type Season = 'prolece' | 'leto' | 'jesen' | 'zima';

export const SEASONS: Season[] = ['prolece', 'leto', 'jesen', 'zima'];

/** Maps a GoSimple document field onto a column in the backing store. */
export type ColumnMap = Record<string, string>;

export type SourceDecl = {
  kind: 'source';
  name: string;
  uri: string;
  /** Required for SQL backends, ignored for file backends. */
  table: string | null;
  columns: ColumnMap;
  /**
   * Static SQL predicate appended to the generated query. It comes from the
   * program text, never from a request, and the compiler rejects statement
   * separators and comment markers inside it.
   */
  where: string | null;
  limit: number | null;
  span: Span;
};

export type CategoryDecl = {
  kind: 'category';
  name: string;
  /** Words that may refer to this category. Ambiguity across categories is expected. */
  terms: string[];
  /** Disambiguating context words. A match here is what locks an intent. */
  signals: string[];
  /** Seasons in which this category earns a seasonal boost. */
  seasons: Season[];
  span: Span;
};

export type TaxonomyDecl = {
  kind: 'taxonomy';
  categories: CategoryDecl[];
  span: Span;
};

export type IntentRule = {
  name: string;
  /** Category whose `signals` must match the query for this rule to fire. */
  whenSignalOf: string;
  thenCategory: string;
  confidence: number;
  /** A locked intent cannot be overridden by seasonal or popularity signals. */
  lock: boolean;
  span: Span;
};

export type IntentDecl = {
  kind: 'intent';
  name: string;
  rules: IntentRule[];
  /** Below this confidence the engine reports the query as ambiguous. */
  ambiguousBelow: number;
  span: Span;
};

export type MatchClause = { field: string; weight: number; span: Span };
export type RankClause = { signal: string; weight: number; span: Span };

export type SearchBlock = {
  kind: 'search';
  retrieve: number;
  match: MatchClause[];
  rank: RankClause[];
  protectIntent: boolean;
  diversify: { field: string; max: number } | null;
  excludeUnavailable: boolean;
  explain: boolean;
  topN: number;
  span: Span;
};

export type FactorClause = { factor: string; weight: number; span: Span };

export type RecommendBlock = {
  kind: 'recommend';
  learnFrom: string[];
  /** `account for [...]` — factors enabled with their default weights. */
  accountFor: string[];
  /** `factors { ... }` — factors enabled with explicit weights. */
  factors: FactorClause[];
  /** `explore <0..1>`, or null to use the default share. */
  explore: number | null;
  excludeRecentlySeen: boolean;
  topN: number;
  span: Span;
};

export type ContentBlock = {
  kind: 'content';
  analyze: string[];
  scores: string[];
  span: Span;
};

export type EngineDecl = {
  kind: 'engine';
  name: string;
  useSource: string | null;
  useIntent: string | null;
  search: SearchBlock | null;
  recommend: RecommendBlock | null;
  content: ContentBlock | null;
  span: Span;
};

/** Behavioural event log backing the recommend block. */
export type EventsDecl = {
  kind: 'events';
  uri: string;
  span: Span;
};

export type Decl = SourceDecl | TaxonomyDecl | IntentDecl | EngineDecl | EventsDecl;

export type Program = {
  kind: 'program';
  decls: Decl[];
};
