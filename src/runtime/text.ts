/**
 * Text normalization for Serbian and other Latin/Cyrillic mixed content.
 *
 * A shopper types "svecice", the catalog says "свећице", and a third listing
 * says "Svećice". All three must collide onto the same token, or none of the
 * ranking logic downstream matters.
 *
 * Normalization pipeline: Cyrillic -> Latin, lowercase, digraph folding,
 * diacritic folding, NFC. The order matters: digraphs must fold before
 * diacritics so "nj" and "њ" converge.
 */

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'dj', е: 'e', ж: 'z', з: 'z',
  и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', ћ: 'c', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'c', џ: 'dz', ш: 's',
};

/** Serbian Latin letters with diacritics, folded to their base form. */
const DIACRITIC_TO_BASE: Record<string, string> = {
  č: 'c', ć: 'c', đ: 'dj', š: 's', ž: 'z',
};

/**
 * Folds one token to its canonical comparison form.
 * Idempotent: normalize(normalize(x)) === normalize(x).
 */
export function normalize(input: string): string {
  let out = input.normalize('NFC').toLowerCase();

  let result = '';
  for (const ch of out) {
    const cyr = CYRILLIC_TO_LATIN[ch];
    if (cyr !== undefined) {
      result += cyr;
      continue;
    }
    const base = DIACRITIC_TO_BASE[ch];
    result += base !== undefined ? base : ch;
  }
  out = result;

  // Strip any remaining combining marks (e.g. decomposed input).
  out = out.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
  return out;
}

/** Splits text into normalized tokens, dropping punctuation and stopwords. */
export function tokenizeText(input: string): string[] {
  return normalize(input)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Serbian function words. Removing them keeps "svećice za Subaru" from
 * scoring "za" as a meaningful match against every product in the catalog.
 */
export const STOPWORDS = new Set([
  'i', 'a', 'ali', 'ili', 'pa', 'te', 'da', 'je', 'su', 'sam', 'si', 'smo', 'ste',
  'u', 'na', 'za', 'od', 'do', 'sa', 's', 'iz', 'o', 'po', 'pri', 'kod', 'uz',
  'se', 'li', 'ne', 'ni', 'bi', 'ce', 'cu', 'ces', 'bez', 'kao', 'to', 'the',
]);

/**
 * Light suffix stripper for Serbian inflection.
 *
 * This is deliberately conservative: it only strips endings when a reasonable
 * stem remains. It is not a real morphological analyzer and does not try to
 * be. The goal is that "svećice", "svećica" and "svećicu" collapse together.
 */
export function stem(token: string): string {
  const SUFFIXES = [
    'ovima', 'evima', 'ama', 'ima', 'oga', 'ega', 'og', 'eg', 'om', 'em',
    'ih', 'im', 'iju', 'ju', 'ama', 'ove', 'eve', 'ovi', 'evi',
    'a', 'e', 'i', 'o', 'u',
  ];
  const MIN_STEM = 4;

  for (const suffix of SUFFIXES) {
    if (token.length - suffix.length >= MIN_STEM && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

/** Normalized + stemmed tokens, used for recall-oriented matching. */
export function stemTokens(input: string): string[] {
  return tokenizeText(input).map(stem);
}

/**
 * Jaccard-style overlap between two token sets, in [0, 1].
 * Used as the lexical relevance component.
 */
export function overlapScore(queryTokens: string[], docTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const doc = new Set(docTokens);
  let hits = 0;
  for (const token of new Set(queryTokens)) {
    if (doc.has(token)) hits++;
  }
  return hits / new Set(queryTokens).size;
}
