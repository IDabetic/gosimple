/**
 * Near-duplicate detection across a catalogue.
 *
 * The obvious implementation compares every document against every other one
 * and keeps the highest Jaccard overlap. That is what this module replaced,
 * and it was quadratic in the worst possible way: building the engine over
 * 10.000 products took 29 seconds, and 100.000 would have taken most of an
 * hour. Startup cost that grows like that is not a performance detail, it is
 * the difference between a language people can use and a demo.
 *
 * Two observations make it near-linear instead.
 *
 * Documents that share no shingle have an overlap of exactly zero, so there
 * is no reason to look at them. An inverted index from shingle to document
 * turns "compare with everything" into "compare with the few that overlap".
 *
 * Catalogues are full of copy-paste. Hundreds of listings can carry byte-
 * identical marketing text, and those are precisely the pairs that defeat
 * the inverted index, because every one of them shares every shingle. They
 * are also the easiest case to answer: identical text means overlap 1, no
 * comparison needed. Grouping them first removes the pathological cluster
 * before the index is built.
 *
 * The index is incremental, because duplication is the one content signal
 * that is a property of the catalogue rather than of a document. Adding one
 * product can change another product's originality, so a shop that edits its
 * catalogue cannot simply re-analyze the edited row. Rebuilding everything
 * would cost the full startup time on every change. Instead the index
 * remembers, for each document, which other document it matched best; when
 * that partner disappears the score is recomputed, and when a new document
 * arrives it is offered to everything it overlaps with.
 */

import { stem, tokenizeText } from './text.ts';

/** Word shingles. Four words is long enough to be distinctive. */
export function shingles(text: string, size = 4): Set<string> {
  const tokens = tokenizeText(text).map(stem);
  const out = new Set<string>();
  for (let i = 0; i + size <= tokens.length; i++) {
    out.add(tokens.slice(i, i + size).join(' '));
  }
  return out;
}

export type DuplicationOptions = {
  /**
   * How many candidate documents to gather before verifying.
   *
   * Gathering is the only approximate step. Verification is exact, so this
   * bounds how much work a document can cause without ever inflating its
   * score: a missed candidate lowers the result, never raises it.
   */
  candidateLimit?: number;
};

const DEFAULT_CANDIDATE_LIMIT = 48;

/**
 * Posting entries read from a single shingle before moving on.
 *
 * Rare shingles have short lists and are read whole, which is what makes
 * the common case exact: a document and its near-copy share their rare
 * shingles, so they always find each other. Only a document whose every
 * shingle is widespread gets truncated, and that only happens inside a
 * large cluster of similar text, where the members are interchangeable and
 * any sample of them answers the question just as well.
 */
const PER_SHINGLE_SCAN_LIMIT = 256;

export type DuplicationEntry = { id: string; text: string };

/** The best match found for a document, and how strong it was. */
type Match = { partner: string | null; score: number };

const NO_MATCH: Match = { partner: null, score: 0 };

export class DuplicationIndex {
  private readonly candidateLimit: number;

  private texts = new Map<string, string>();
  private sets = new Map<string, Set<string>>();
  /** shingle -> ids containing it. A set, so removal is not a linear scan. */
  private postings = new Map<string, Set<string>>();
  /** exact text -> ids. Identical documents answer each other for free. */
  private groups = new Map<string, Set<string>>();
  private matches = new Map<string, Match>();

  constructor(entries: DuplicationEntry[] = [], options: DuplicationOptions = {}) {
    this.candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
    if (entries.length > 0) this.apply(entries, []);
  }

  get size(): number {
    return this.texts.size;
  }

  /** Highest overlap this document has with any other, in [0, 1]. */
  scoreOf(id: string): number {
    return this.matches.get(id)?.score ?? 0;
  }

  /**
   * Adds, replaces and removes documents, then repairs every score the
   * change could have altered.
   *
   * Batched on purpose. Finding which documents depended on a removed one
   * costs a pass over the index, and a reload that drops a thousand rows
   * should pay for that pass once rather than a thousand times.
   */
  apply(upserts: DuplicationEntry[], removals: string[] = []): void {
    /** Documents whose score has to be worked out again from scratch. */
    const dirty = new Set<string>();
    /** Exact-text groups that changed size; survivors may lose their 1.0. */
    const touchedGroups = new Set<string>();
    const departed = new Set<string>();

    for (const id of removals) {
      if (this.detach(id, touchedGroups)) departed.add(id);
    }

    for (const entry of upserts) {
      // An unchanged document is left alone: re-adding it would make it its
      // own neighbour's neighbour for no reason and churn the index.
      if (this.texts.get(entry.id) === entry.text) continue;
      if (this.texts.has(entry.id)) {
        this.detach(entry.id, touchedGroups);
        departed.add(entry.id);
      }
      this.attach(entry.id, entry.text, touchedGroups);
      dirty.add(entry.id);
    }

    if (departed.size > 0) {
      // Whoever leaned on a document that is gone has to look again. This is
      // the one pass over the whole index, and it is why `apply` is batched.
      for (const [id, match] of this.matches) {
        if (match.partner !== null && departed.has(match.partner)) dirty.add(id);
      }
    }

    for (const key of touchedGroups) {
      const members = this.groups.get(key);
      if (!members) continue;
      // Every member of a group that changed size needs another look. One
      // that grew just handed its existing members a perfect match; one
      // that shrank to a single document took that match away. Re-scoring
      // a group member is cheap — identical text answers itself.
      for (const id of members) dirty.add(id);
    }

    for (const id of dirty) {
      if (this.texts.has(id)) this.matches.set(id, this.computeMatch(id));
    }

    // A new document can only raise its neighbours' scores, never lower
    // them, so offering it around is enough — no second recomputation.
    for (const entry of upserts) {
      const own = this.sets.get(entry.id);
      if (!own || own.size === 0) continue;
      for (const other of this.candidatesFor(entry.id, own)) {
        const overlap = this.jaccard(own, this.sets.get(other)!);
        const current = this.matches.get(other) ?? NO_MATCH;
        if (overlap > current.score) this.matches.set(other, { partner: entry.id, score: overlap });
      }
    }
  }

  // --- internals ----------------------------------------------------------

  private groupKey(text: string): string {
    return text.trim();
  }

  /** Removes a document from every structure. Returns false if it was absent. */
  private detach(id: string, touchedGroups: Set<string>): boolean {
    const text = this.texts.get(id);
    if (text === undefined) return false;

    for (const shingle of this.sets.get(id) ?? []) {
      const holders = this.postings.get(shingle);
      if (!holders) continue;
      holders.delete(id);
      if (holders.size === 0) this.postings.delete(shingle);
    }

    const key = this.groupKey(text);
    const members = this.groups.get(key);
    if (members) {
      members.delete(id);
      touchedGroups.add(key);
      if (members.size === 0) this.groups.delete(key);
    }

    this.texts.delete(id);
    this.sets.delete(id);
    this.matches.delete(id);
    return true;
  }

  private attach(id: string, text: string, touchedGroups: Set<string>): void {
    const own = shingles(text);
    this.texts.set(id, text);
    this.sets.set(id, own);

    for (const shingle of own) {
      const holders = this.postings.get(shingle);
      if (holders) holders.add(id);
      else this.postings.set(shingle, new Set([id]));
    }

    const key = this.groupKey(text);
    const members = this.groups.get(key);
    if (members) members.add(id);
    else this.groups.set(key, new Set([id]));
    touchedGroups.add(key);
  }

  /** Exact Jaccard, iterating the smaller set. */
  private jaccard(a: Set<string>, b: Set<string>): number {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let intersection = 0;
    for (const shingle of small) if (large.has(shingle)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /** Documents worth comparing against, gathered rarest shingle first. */
  private candidatesFor(id: string, own: Set<string>): Set<string> {
    const found = new Set<string>();

    // Rarest shingles first. A shingle shared by half the catalogue says
    // nothing about who copied whom; a shingle shared by two documents says
    // everything. Reading the informative lists first is what lets the walk
    // stop early without losing the answer.
    const ordered = [...own].sort(
      (a, b) => (this.postings.get(a)?.size ?? 0) - (this.postings.get(b)?.size ?? 0),
    );

    for (const shingle of ordered) {
      if (found.size >= this.candidateLimit) break;
      const holders = this.postings.get(shingle);
      if (!holders) continue;

      let seen = 0;
      for (const other of holders) {
        if (seen++ >= PER_SHINGLE_SCAN_LIMIT) break;
        if (other !== id) found.add(other);
      }
    }

    return found;
  }

  private computeMatch(id: string): Match {
    const own = this.sets.get(id);
    if (!own || own.size === 0) return NO_MATCH;

    // Identical text needs no comparison — but only if there is anything to
    // compare. A text shorter than one shingle produces no evidence, and
    // this module does not make claims it cannot support. Two blank
    // descriptions are not plagiarism, they are two blank descriptions.
    const members = this.groups.get(this.groupKey(this.texts.get(id)!));
    if (members && members.size > 1) {
      for (const twin of members) if (twin !== id) return { partner: twin, score: 1 };
    }

    // Verify exactly. The index narrowed the field from the whole catalogue
    // to a handful; the number reported is a real Jaccard over real sets,
    // never an estimate.
    let best = NO_MATCH;
    for (const other of this.candidatesFor(id, own)) {
      const score = this.jaccard(own, this.sets.get(other)!);
      if (score > best.score) best = { partner: other, score };
    }
    return best;
  }
}

/**
 * Highest shingle overlap of each text against any other text in the array.
 *
 * Returns a parallel array: `result[i]` is the duplication score of
 * `texts[i]`, in [0, 1].
 */
export function buildDuplicationScores(
  texts: string[],
  options: DuplicationOptions = {},
): number[] {
  const index = new DuplicationIndex(
    texts.map((text, i) => ({ id: String(i), text })),
    options,
  );
  return texts.map((_, i) => index.scoreOf(String(i)));
}

/**
 * Reference implementation: compares every pair.
 *
 * Kept because the fast path is only trustworthy if something checks it.
 * Tests run both over a small corpus and require identical output.
 */
export function buildDuplicationScoresNaive(texts: string[]): number[] {
  const sets = texts.map((t) => shingles(t));
  return sets.map((own, i) => {
    let best = 0;
    for (let j = 0; j < sets.length; j++) {
      if (i === j) continue;
      const other = sets[j]!;
      let intersection = 0;
      for (const shingle of own) if (other.has(shingle)) intersection++;
      const union = own.size + other.size - intersection;
      if (union > 0) best = Math.max(best, intersection / union);
    }
    return best;
  });
}
