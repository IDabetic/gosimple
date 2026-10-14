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
   * Gathering is the only approximate step. Verification below is exact, so
   * this bounds how much work a document can cause without ever inflating
   * its score: a missed candidate lowers the result, never raises it.
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

/**
 * Highest shingle overlap of each text against any other text in the array.
 *
 * Returns a parallel array: `result[i]` is the duplication score of
 * `texts[i]`, in [0, 1]. Exact for every pair that shares a shingle within
 * the posting budget, which on real data is every pair that shares one.
 */
export function buildDuplicationScores(
  texts: string[],
  options: DuplicationOptions = {},
): number[] {
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const scores = new Array<number>(texts.length).fill(0);
  if (texts.length < 2) return scores;

  // --- Collapse exact duplicates ------------------------------------------
  // Identical text is the common case in a copy-pasted catalogue and the one
  // that would otherwise dominate the cost. It also needs no comparison.
  const byText = new Map<string, number[]>();
  for (let i = 0; i < texts.length; i++) {
    const key = texts[i]!.trim();
    const bucket = byText.get(key);
    if (bucket) bucket.push(i);
    else byText.set(key, [i]);
  }

  /** One index per distinct text; the rest inherit its score. */
  const representatives: number[] = [];
  const shingleSets = new Map<number, Set<string>>();

  for (const members of byText.values()) {
    const representative = members[0]!;
    const own = shingles(texts[representative]!);
    shingleSets.set(representative, own);
    representatives.push(representative);

    // Identical texts overlap completely — but only if there is anything to
    // overlap. A text shorter than one shingle produces no evidence, and
    // this module does not make claims it cannot support. Two blank
    // descriptions are not plagiarism, they are two blank descriptions.
    if (members.length > 1 && own.size > 0) {
      for (const member of members) scores[member] = 1;
    }
  }

  if (representatives.length < 2) return scores;

  // --- Index the distinct texts -------------------------------------------
  const sets = representatives.map((index) => shingleSets.get(index)!);
  const postings = new Map<string, number[]>();

  for (let slot = 0; slot < sets.length; slot++) {
    for (const shingle of sets[slot]!) {
      const list = postings.get(shingle);
      if (list) list.push(slot);
      else postings.set(shingle, [slot]);
    }
  }

  // --- Score each distinct text against its overlapping neighbours --------
  const candidates = new Set<number>();

  for (let slot = 0; slot < sets.length; slot++) {
    const own = sets[slot]!;
    if (own.size === 0) continue;

    // Rarest shingles first. A shingle shared by half the catalogue says
    // nothing about who copied whom; a shingle shared by two documents says
    // everything. Reading the informative lists first is what lets the walk
    // stop early without losing the answer.
    const ordered = [...own].sort(
      (a, b) => (postings.get(a)?.length ?? 0) - (postings.get(b)?.length ?? 0),
    );

    candidates.clear();

    for (const shingle of ordered) {
      if (candidates.size >= candidateLimit) break;
      const list = postings.get(shingle)!;
      const scan = Math.min(list.length, PER_SHINGLE_SCAN_LIMIT);
      for (let k = 0; k < scan; k++) {
        const other = list[k]!;
        if (other !== slot) candidates.add(other);
      }
    }

    // Verify exactly. The index narrowed the field from the whole catalogue
    // to a handful; the number reported is a real Jaccard over real sets,
    // never an estimate.
    let best = 0;
    for (const other of candidates) {
      const theirs = sets[other]!;
      // Iterating the smaller set keeps the cost at min(|a|, |b|).
      const [small, large] = own.size <= theirs.size ? [own, theirs] : [theirs, own];
      let intersection = 0;
      for (const shingle of small) if (large.has(shingle)) intersection++;

      const union = own.size + theirs.size - intersection;
      if (union === 0) continue;
      const jaccard = intersection / union;
      if (jaccard > best) best = jaccard;
    }

    const index = representatives[slot]!;
    if (best > scores[index]!) scores[index] = best;
  }

  // --- Propagate representative scores to their groups --------------------
  for (const members of byText.values()) {
    if (members.length === 1) continue;
    const score = scores[members[0]!]!;
    for (const member of members) scores[member] = score;
  }

  return scores;
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
