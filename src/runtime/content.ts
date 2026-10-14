/**
 * Content Intelligence: measurable writing features, not verdicts.
 *
 * This module never claims "this text was written by AI". That claim is not
 * supportable from text alone, and a system that makes it will eventually
 * penalize an honest seller who writes tidy prose. What it does instead is
 * report observable features (sentence uniformity, specificity, filler
 * density, lexical diversity, near-duplication) with a confidence value and
 * the concrete evidence behind each one.
 *
 * Callers decide policy. The language exposes the evidence.
 */

import { normalize, stem, tokenizeText } from './text.ts';
import { buildDuplicationScores } from './duplication.ts';

export type ContentFeatures = {
  /** Variance in sentence length. Human prose is bursty; templates are flat. */
  burstiness: number;
  /** Density of concrete detail: numbers, units, model codes. */
  specificity: number;
  /** Share of tokens belonging to generic marketing filler. */
  fillerDensity: number;
  /** Type-to-token ratio, a proxy for vocabulary range. */
  lexicalDiversity: number;
  /** Highest shingle overlap against the rest of the corpus, in [0, 1]. */
  duplication: number;
  sentenceCount: number;
  tokenCount: number;
};

export type Evidence = { feature: string; observation: string; weight: number };

export type ContentReport = {
  features: ContentFeatures;
  /**
   * How strongly the text resembles templated or machine-assisted writing.
   * This is a similarity score, not an authorship determination.
   */
  templateLikeness: { score: number; confidence: number; evidence: Evidence[] };
  /** Completeness and usefulness of the description, in [0, 1]. */
  quality: number;
  /** Distinctiveness against the rest of the corpus, in [0, 1]. */
  originality: number;
};

/** Generic marketing phrases that carry no product-specific information. */
const FILLER = new Set(
  [
    'kvalitetan', 'kvalitetno', 'vrhunski', 'vrhunsko', 'odlican', 'odlicno',
    'savrsen', 'savrseno', 'idealan', 'idealno', 'pouzdan', 'pouzdano',
    'moderan', 'moderno', 'elegantan', 'elegantno', 'praktican', 'prakticno',
    'siguran', 'sigurno', 'najbolji', 'povoljno', 'nezaobilazan', 'jedinstven',
    'resenje', 'iskustvo', 'potrebe', 'zadovoljstvo', 'izbor', 'ponuda',
    'premium', 'perfect', 'ideal', 'quality', 'reliable', 'solution',
    'experience', 'ultimate', 'seamless', 'versatile', 'enhance', 'elevate',
  ].map(normalize),
);

/** Units and measurement markers that signal concrete specification. */
const UNIT_PATTERN = /\b\d+([.,]\d+)?\s?(mm|cm|m|kg|g|ml|l|v|w|kw|ah|mah|hz|khz|gb|tb|mb|a|nm|°c|%)\b/giu;
const MODEL_CODE_PATTERN = /\b[a-z]{1,4}[-/]?\d{2,}[a-z0-9-]*\b/giu;

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+(?:\s|$)/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function extractFeatures(text: string, duplication = 0): ContentFeatures {
  const sentences = splitSentences(text);
  const tokens = tokenizeText(text);
  const tokenCount = tokens.length;

  // Burstiness: coefficient of variation of sentence lengths.
  const lengths = sentences.map((s) => tokenizeText(s).length).filter((n) => n > 0);
  let burstiness = 0;
  if (lengths.length >= 2) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((acc, n) => acc + (n - mean) ** 2, 0) / lengths.length;
    burstiness = mean > 0 ? clamp01(Math.sqrt(variance) / mean) : 0;
  }

  // Specificity: concrete detail per 100 tokens.
  const units = text.match(UNIT_PATTERN)?.length ?? 0;
  const codes = text.match(MODEL_CODE_PATTERN)?.length ?? 0;
  const digits = (text.match(/\d/gu)?.length ?? 0) / Math.max(1, text.length);
  const specificity = tokenCount === 0 ? 0 : clamp01(((units * 3 + codes * 2) / tokenCount) * 10 + digits * 2);

  // Filler density.
  const fillerHits = tokens.filter((t) => FILLER.has(t)).length;
  const fillerDensity = tokenCount === 0 ? 0 : clamp01(fillerHits / tokenCount);

  // Lexical diversity, length-corrected so short texts are not flattered.
  const unique = new Set(tokens.map(stem)).size;
  const lexicalDiversity = tokenCount === 0 ? 0 : clamp01(unique / Math.sqrt(Math.max(1, tokenCount)) / 3);

  return {
    burstiness,
    specificity,
    fillerDensity,
    lexicalDiversity,
    duplication,
    sentenceCount: sentences.length,
    tokenCount,
  };
}

/**
 * Analyzes one text.
 *
 * `duplication` is supplied by the caller rather than computed here, because
 * it is a property of the text's relationship to the rest of the catalogue,
 * not of the text itself. Computing it per call meant comparing every
 * document with every other one; see runtime/duplication.ts.
 */
export function analyzeContent(text: string, duplication = 0): ContentReport {
  const features = extractFeatures(text, clamp01(duplication));
  const evidence: Evidence[] = [];

  // Each contribution is bounded so no single feature can dominate the score.
  let score = 0;

  if (features.sentenceCount >= 3 && features.burstiness < 0.25) {
    const weight = 0.25;
    score += weight;
    evidence.push({
      feature: 'burstiness',
      observation: `Dužine rečenica su neuobičajeno ujednačene (varijacija ${features.burstiness.toFixed(2)}).`,
      weight,
    });
  }
  if (features.fillerDensity > 0.12) {
    const weight = 0.25;
    score += weight;
    evidence.push({
      feature: 'filler',
      observation: `${(features.fillerDensity * 100).toFixed(0)}% reči su opšte marketinške fraze bez konkretne informacije.`,
      weight,
    });
  }
  if (features.specificity < 0.1 && features.tokenCount > 20) {
    const weight = 0.2;
    score += weight;
    evidence.push({
      feature: 'specificity',
      observation: 'Opis ne sadrži mere, oznake modela ni druge proverljive podatke.',
      weight,
    });
  }
  if (features.duplication > 0.4) {
    const weight = 0.3;
    score += weight;
    evidence.push({
      feature: 'duplication',
      observation: `Tekst se ${(features.duplication * 100).toFixed(0)}% poklapa sa drugim opisom u katalogu.`,
      weight,
    });
  }

  /**
   * Confidence scales with how much text there is to judge. Three sentences
   * is not enough to say anything, and the report says so rather than
   * pretending otherwise.
   */
  const confidence = clamp01(
    Math.min(features.tokenCount / 120, 1) * Math.min(features.sentenceCount / 4, 1),
  );

  const quality = clamp01(
    0.35 * features.specificity +
      0.25 * features.lexicalDiversity +
      0.2 * Math.min(features.tokenCount / 80, 1) +
      0.2 * (1 - features.fillerDensity),
  );

  const originality = clamp01(1 - features.duplication);

  return {
    features,
    templateLikeness: { score: clamp01(score), confidence, evidence },
    quality,
    originality,
  };
}

/**
 * Analyzes a whole catalogue, computing cross-document duplication once.
 *
 * This is the entry point callers should use: analyzing documents one at a
 * time cannot see duplication at all, and analyzing them in a loop against
 * the full corpus is quadratic.
 */
export function analyzeCorpus(texts: string[]): ContentReport[] {
  const duplication = buildDuplicationScores(texts);
  return texts.map((text, index) => analyzeContent(text, duplication[index]));
}
