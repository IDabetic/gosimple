/**
 * Intent resolution.
 *
 * This is the part of GoSimple that does not exist in Elasticsearch or Vespa
 * as a first-class concept, and it is the reason the language is worth
 * building.
 *
 * The problem: "svećice" is genuinely ambiguous. It can mean spark plugs,
 * garden candles, or Christmas lights. A seasonal boost applied blindly will
 * send a driver shopping for spark plugs in December to the tree lights.
 *
 * The rule this module enforces: a *signal* in the query (an explicit context
 * word like "Subaru" or "bašta") resolves the ambiguity and locks the intent.
 * Once locked, contextual signals such as season and popularity are not
 * permitted to move the user out of the category they explicitly asked for.
 *
 * When nothing disambiguates, the engine reports the query as ambiguous and
 * hands back the competing categories so the application can ask instead of
 * guessing.
 */

import type { Plan } from '../ir.ts';
import { normalize, stem, tokenizeText } from './text.ts';

export type IntentResolution = {
  /** Category the query resolved to, or null when ambiguous. */
  category: string | null;
  confidence: number;
  /** A locked intent may not be overridden by seasonal or popularity signals. */
  locked: boolean;
  /** True when the query matched ambiguous terms and nothing disambiguated them. */
  ambiguous: boolean;
  /** Competing categories, for a clarifying question or a split result page. */
  candidates: string[];
  /** Query words that matched a disambiguating signal. */
  matchedSignals: Array<{ token: string; category: string }>;
  /** Name of the intent rule that fired, if any. */
  firedRule: string | null;
  /** Human-readable trace of how the decision was made. */
  trace: string[];
};

export function resolveIntent(plan: Plan, query: string): IntentResolution {
  const trace: string[] = [];
  const tokens = tokenizeText(query);
  const forms = new Set<string>();
  for (const token of tokens) {
    forms.add(token);
    forms.add(stem(token));
  }

  // Which categories claim any word in this query?
  const candidateSet = new Set<string>();
  for (const form of forms) {
    const hits = plan.indexes.termToCategories[form];
    if (hits) for (const category of hits) candidateSet.add(category);
  }
  const candidates = [...candidateSet];

  if (candidates.length === 0) {
    trace.push('Nijedan term iz upita ne pripada deklarisanoj taksonomiji.');
    return {
      category: null,
      confidence: 0,
      locked: false,
      ambiguous: false,
      candidates: [],
      matchedSignals: [],
      firedRule: null,
      trace,
    };
  }

  trace.push(
    candidates.length === 1
      ? `Upit jednoznačno pripada kategoriji "${candidates[0]}".`
      : `Upit je dvosmislen između: ${candidates.join(', ')}.`,
  );

  // Which disambiguating signals appear in the query?
  const matchedSignals: Array<{ token: string; category: string }> = [];
  for (const form of forms) {
    const category = plan.indexes.signalToCategory[form];
    if (category !== undefined) matchedSignals.push({ token: form, category });
  }

  if (matchedSignals.length > 0) {
    trace.push(
      `Pronađeni signali konteksta: ${matchedSignals.map((s) => `"${s.token}" → ${s.category}`).join(', ')}.`,
    );
  }

  // Apply intent rules in declaration order; the first match wins.
  if (plan.intent) {
    for (const rule of plan.intent.rules) {
      const hit = matchedSignals.find((s) => s.category === rule.whenSignalOf);
      if (!hit) continue;

      trace.push(
        `Pravilo "${rule.name}" se aktiviralo na signal "${hit.token}" → kategorija "${rule.thenCategory}"` +
          (rule.lock ? ', namera je ZAKLJUČANA.' : '.'),
      );
      return {
        category: rule.thenCategory,
        confidence: rule.confidence,
        locked: rule.lock,
        ambiguous: false,
        candidates,
        matchedSignals,
        firedRule: rule.name,
        trace,
      };
    }
  }

  // No rule fired. A single candidate is still an unambiguous answer, just an
  // unlocked one: seasonal signals may legitimately shape these results.
  if (candidates.length === 1) {
    trace.push('Nijedno pravilo nije aktivirano, ali postoji samo jedan kandidat; namera nije zaključana.');
    return {
      category: candidates[0]!,
      confidence: 0.75,
      locked: false,
      ambiguous: false,
      candidates,
      matchedSignals,
      firedRule: null,
      trace,
    };
  }

  // Genuinely ambiguous: confidence is the share of a single candidate.
  const confidence = 1 / candidates.length;
  const threshold = plan.intent?.ambiguousBelow ?? 0.5;
  const ambiguous = confidence < threshold;

  trace.push(
    ambiguous
      ? `Pouzdanost ${confidence.toFixed(2)} je ispod praga ${threshold}; upit se tretira kao dvosmislen. Sezonski kontekst sme da predloži smer, ali rezultat treba označiti kao nepotvrđen.`
      : `Pouzdanost ${confidence.toFixed(2)} je iznad praga ${threshold}.`,
  );

  return {
    category: null,
    confidence,
    locked: false,
    ambiguous,
    candidates,
    matchedSignals,
    firedRule: null,
    trace,
  };
}

/** Maps a date onto a season. Northern hemisphere; meteorological boundaries. */
export function seasonOf(date: Date): 'prolece' | 'leto' | 'jesen' | 'zima' {
  const month = date.getMonth() + 1;
  if (month >= 3 && month <= 5) return 'prolece';
  if (month >= 6 && month <= 8) return 'leto';
  if (month >= 9 && month <= 11) return 'jesen';
  return 'zima';
}

/** Normalizes a free-text signal for lookup against the compiled index. */
export function normalizeSignal(token: string): string {
  return normalize(token);
}
