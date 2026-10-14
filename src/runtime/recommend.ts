/**
 * Recommendation engine.
 *
 * Three strategies, chosen by how much is actually known about the user
 * rather than by configuration:
 *
 *   warm  — the user has history: item-to-item collaborative filtering over
 *           the event log, blended with content similarity
 *   cool  — the user is new but a seed item is known (a product page): pure
 *           item-to-item similarity from the seed
 *   cold  — nothing is known: popularity and season
 *
 * Which one ran is reported in the response. A recommender that silently
 * degrades to "most popular" while presenting itself as personalised is the
 * most common way these systems lie to the people who operate them.
 *
 * Two biases are corrected explicitly, because both get worse over time if
 * left alone:
 *
 *   Popularity bias — co-occurrence counts are divided by the geometric mean
 *   of each item's own interaction mass (cosine normalisation). Without it,
 *   the single best-selling product co-occurs with everything and is
 *   recommended everywhere.
 *
 *   Feedback loops — an explicit dismissal subtracts from the score and a
 *   configurable share of the slate is reserved for items outside the user's
 *   existing categories, so the system keeps offering things the user has not
 *   already been shown.
 */

import { HISTORY_DEPENDENT_FACTORS, type IRRecommend, type Plan, type RecommendFactor } from '../ir.ts';
import type { Doc } from './execute.ts';
import { seasonOf } from './intent.ts';
import { stem, tokenizeText } from './text.ts';

export const EVENT_TYPES = [
  'views',
  'clicks',
  'add_to_cart',
  'purchases',
  'saved_items',
  'dismissals',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type Event = {
  userId: string;
  docId: string;
  type: EventType;
  /** ISO timestamp. Absent events are treated as old. */
  at?: string;
};

/**
 * Relative strength of each signal. A purchase says far more about intent
 * than a page view, and a dismissal is negative evidence rather than absent
 * evidence.
 */
const EVENT_WEIGHT: Record<EventType, number> = {
  views: 1,
  clicks: 2,
  add_to_cart: 5,
  saved_items: 6,
  purchases: 10,
  dismissals: -6,
};

export type RecommendRequest = {
  userId?: string;
  /** Current product, for "similar items" on a detail page. */
  seedIds?: string[];
  budget?: number;
  interests?: string[];
  /** Items to keep out of the slate regardless of score. */
  excludeIds?: string[];
  now?: string;
  season?: string;
};

export type RecommendationReason = { factor: string; detail: string; contribution: number };

export type Recommendation = {
  id: string;
  title: string;
  category: string;
  score: number;
  reasons: RecommendationReason[];
};

export type RecommendResponse = {
  engine: string;
  strategy: 'warm' | 'cool' | 'cold';
  season: string;
  /** Number of events found for this user. Zero explains a cold strategy. */
  userHistorySize: number;
  items: Recommendation[];
  stats: {
    candidates: number;
    excludedSeen: number;
    excludedDismissed: number;
    exploration: number;
    returned: number;
    durationMs: number;
  };
};

export class EventValidationError extends Error {}

/** Validates and normalizes a raw event log. */
export function parseEvents(raw: unknown): Event[] {
  if (!Array.isArray(raw)) {
    throw new EventValidationError('Dnevnik događaja mora biti JSON niz.');
  }

  const events: Event[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new EventValidationError(`Događaj na poziciji ${index} nije objekat.`);
    }
    const e = entry as Record<string, unknown>;
    const userId = e.userId ?? e.user_id;
    const docId = e.docId ?? e.doc_id ?? e.productId ?? e.product_id;
    const type = e.type ?? e.event;

    if (typeof userId !== 'string' || !userId) {
      throw new EventValidationError(`Događaj na poziciji ${index} nema userId.`);
    }
    if (typeof docId !== 'string' || !docId) {
      throw new EventValidationError(`Događaj na poziciji ${index} nema docId.`);
    }
    if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) {
      throw new EventValidationError(
        `Događaj na poziciji ${index} ima nepoznat tip "${String(type)}". Dozvoljeno: ${EVENT_TYPES.join(', ')}.`,
      );
    }

    const event: Event = { userId, docId, type: type as EventType };
    if (typeof e.at === 'string') event.at = e.at;
    events.push(event);
  });

  return events;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export class Recommender {
  private plan: Plan;
  private config: IRRecommend;
  private docs: Doc[];
  private docById = new Map<string, Doc>();
  private docTags = new Map<string, Set<string>>();

  /** userId -> docId -> accumulated weight (dismissals excluded). */
  private userProfiles = new Map<string, Map<string, number>>();
  /** userId -> docIds the user explicitly dismissed. */
  private dismissed = new Map<string, Set<string>>();
  /** docId -> userId -> weight, the transpose used for co-occurrence. */
  private itemProfiles = new Map<string, Map<string, number>>();
  /** docId -> L2 norm of its user vector, precomputed for cosine. */
  private itemNorms = new Map<string, number>();

  private maxViews = 1;

  constructor(plan: Plan, docs: Doc[], events: Event[]) {
    if (!plan.recommend) {
      throw new Error(`Engine "${plan.engine}" nema recommend blok.`);
    }
    this.plan = plan;
    this.config = plan.recommend;
    this.docs = docs;

    for (const doc of docs) {
      this.docById.set(doc.id, doc);
      this.docTags.set(
        doc.id,
        new Set([...(doc.tags ?? []).flatMap((t) => tokenizeText(t).map(stem)), ...tokenizeText(doc.category).map(stem)]),
      );
      this.maxViews = Math.max(this.maxViews, doc.views ?? 0);
    }

    this.ingest(events);
  }

  /**
   * Builds user and item profiles from the event log.
   *
   * Only event types the program listed in `learn from` are counted, so the
   * declaration is load-bearing rather than documentation.
   */
  private ingest(events: Event[]): void {
    const allowed = new Set(this.config.learnFrom);

    for (const event of events) {
      // Dismissals are always honoured, even when not in `learn from`:
      // ignoring an explicit "no" is never the behaviour an operator wants.
      if (event.type === 'dismissals') {
        let set = this.dismissed.get(event.userId);
        if (!set) {
          set = new Set();
          this.dismissed.set(event.userId, set);
        }
        set.add(event.docId);
        continue;
      }

      if (!allowed.has(event.type)) continue;
      if (!this.docById.has(event.docId)) continue;

      const weight = EVENT_WEIGHT[event.type];

      let profile = this.userProfiles.get(event.userId);
      if (!profile) {
        profile = new Map();
        this.userProfiles.set(event.userId, profile);
      }
      profile.set(event.docId, (profile.get(event.docId) ?? 0) + weight);

      let item = this.itemProfiles.get(event.docId);
      if (!item) {
        item = new Map();
        this.itemProfiles.set(event.docId, item);
      }
      item.set(event.userId, (item.get(event.userId) ?? 0) + weight);
    }

    for (const [docId, users] of this.itemProfiles) {
      let sum = 0;
      for (const weight of users.values()) sum += weight * weight;
      this.itemNorms.set(docId, Math.sqrt(sum));
    }
  }

  /**
   * Cosine similarity between two items over the users who interacted with
   * them. Dividing by both norms is what prevents the catalogue bestseller
   * from looking similar to everything.
   */
  private itemSimilarity(a: string, b: string): number {
    if (a === b) return 0;
    const left = this.itemProfiles.get(a);
    const right = this.itemProfiles.get(b);
    if (!left || !right) return 0;

    // Iterate the smaller side.
    const [small, large] = left.size <= right.size ? [left, right] : [right, left];
    let dot = 0;
    for (const [userId, weight] of small) {
      const other = large.get(userId);
      if (other !== undefined) dot += weight * other;
    }
    if (dot <= 0) return 0;

    const norm = (this.itemNorms.get(a) ?? 0) * (this.itemNorms.get(b) ?? 0);
    return norm > 0 ? clamp01(dot / norm) : 0;
  }

  /** Jaccard overlap of category and tag tokens. */
  private contentSimilarity(a: string, b: string): number {
    const left = this.docTags.get(a);
    const right = this.docTags.get(b);
    if (!left || !right || left.size === 0 || right.size === 0) return 0;

    let intersection = 0;
    for (const tag of left) if (right.has(tag)) intersection++;
    return intersection / (left.size + right.size - intersection);
  }

  recommend(request: RecommendRequest): RecommendResponse {
    const started = performance.now();

    const now = request.now ? new Date(request.now) : new Date();
    const season = request.season ?? seasonOf(now);
    const boosted = new Set(this.plan.indexes.seasonToCategories[season] ?? []);

    const profile = request.userId ? this.userProfiles.get(request.userId) : undefined;
    const history = profile ? [...profile.entries()].filter(([, w]) => w > 0) : [];
    const seeds = request.seedIds?.filter((id) => this.docById.has(id)) ?? [];

    const strategy: RecommendResponse['strategy'] =
      history.length > 0 ? 'warm' : seeds.length > 0 ? 'cool' : 'cold';

    /**
     * Resolve the declared weights for this request.
     *
     * A cold-start visitor has no history and no seed, so `collaborative` and
     * `content` can only ever contribute zero. Leaving their weight unspent
     * would make every cold score a fraction of a warm one and the two would
     * stop being comparable. Instead the unusable weight is redistributed
     * proportionally over the factors that can still fire — the same rule the
     * search path uses when intent protection suppresses a signal.
     */
    const declared = this.config.factors;
    const declaredNames = Object.keys(declared) as RecommendFactor[];
    const usable = new Set(
      declaredNames.filter((f) => strategy !== 'cold' || !HISTORY_DEPENDENT_FACTORS.includes(f)),
    );
    const declaredTotal = declaredNames.reduce((sum, f) => sum + (declared[f] ?? 0), 0);
    const usableTotal = [...usable].reduce((sum, f) => sum + (declared[f] ?? 0), 0);
    const scale = usableTotal > 0 ? declaredTotal / usableTotal : 0;

    const weightOf = (factor: RecommendFactor): number =>
      usable.has(factor) ? (declared[factor] ?? 0) * scale : 0;

    // Items the user already engaged with are not recommendations.
    const seen = new Set<string>();
    if (this.config.excludeRecentlySeen) {
      for (const [docId] of history) seen.add(docId);
      for (const id of seeds) seen.add(id);
    }
    for (const id of request.excludeIds ?? []) seen.add(id);

    const userDismissed = request.userId ? (this.dismissed.get(request.userId) ?? new Set()) : new Set<string>();

    const historyMass = history.reduce((acc, [, w]) => acc + w, 0) || 1;
    const interestTokens = new Set(
      (request.interests ?? []).flatMap((i) => tokenizeText(i).map(stem)),
    );
    const historyCategories = new Set(
      history.map(([docId]) => this.docById.get(docId)?.category).filter((c): c is string => !!c),
    );

    /**
     * Share of the user's engagement that sits in a given category.
     *
     * This is the recommendation-side counterpart to `protect intent`. A flat
     * seasonal boost applied to someone who has only ever bought car parts
     * puts Christmas lights at the top of their slate in December — the same
     * failure the search path exists to prevent, arriving through a different
     * door. Scaling the boost by affinity keeps season meaningful for users it
     * actually fits, while the exploration slots below still guarantee that
     * unfamiliar categories get a chance.
     */
    const categoryAffinity = new Map<string, number>();
    for (const [docId, weight] of history) {
      const category = this.docById.get(docId)?.category;
      if (category) categoryAffinity.set(category, (categoryAffinity.get(category) ?? 0) + weight);
    }
    for (const [category, mass] of categoryAffinity) {
      categoryAffinity.set(category, mass / historyMass);
    }

    let excludedSeen = 0;
    let excludedDismissed = 0;

    const scored: Array<{ doc: Doc; score: number; reasons: RecommendationReason[]; novel: boolean }> = [];

    for (const doc of this.docs) {
      if (doc.available === false) continue;
      // Dismissal is checked before "already seen" because a user almost
      // always views an item before rejecting it. Checking seen first would
      // attribute every rejection to a passive view and make the stats lie
      // about why the item was dropped.
      if (userDismissed.has(doc.id)) {
        excludedDismissed++;
        continue;
      }
      if (seen.has(doc.id)) {
        excludedSeen++;
        continue;
      }

      const reasons: RecommendationReason[] = [];
      let score = 0;

      // Collaborative signal, weighted by how strongly the user engaged with
      // each source item.
      if (weightOf('collaborative') > 0 && (strategy === 'warm' || strategy === 'cool')) {
        const sources = strategy === 'warm' ? history : seeds.map((id) => [id, 1] as [string, number]);
        const mass = strategy === 'warm' ? historyMass : sources.length || 1;

        let collaborative = 0;
        let best: { id: string; value: number } | null = null;

        for (const [sourceId, weight] of sources) {
          const similarity = this.itemSimilarity(sourceId, doc.id);
          if (similarity <= 0) continue;
          collaborative += (similarity * weight) / mass;
          if (!best || similarity > best.value) best = { id: sourceId, value: similarity };
        }

        collaborative = clamp01(collaborative);
        if (collaborative > 0) {
          const contribution = collaborative * weightOf('collaborative');
          score += contribution;
          reasons.push({
            factor: 'zajedničko ponašanje',
            detail: best
              ? `Kupci koji su gledali "${this.docById.get(best.id)?.title ?? best.id}" gledali su i ovo.`
              : 'Pojavljuje se uz artikle iz vaše istorije.',
            contribution: Number(contribution.toFixed(4)),
          });
        }
      }

      // Content similarity to history or seed.
      if (weightOf('content') > 0 && (history.length > 0 || seeds.length > 0)) {
        const sources = history.length > 0 ? history.map(([id]) => id) : seeds;
        let content = 0;
        for (const sourceId of sources) {
          content = Math.max(content, this.contentSimilarity(sourceId, doc.id));
        }
        if (content > 0) {
          const contribution = content * weightOf('content');
          score += contribution;
          reasons.push({
            factor: 'sličan sadržaj',
            detail: `Deli kategoriju ili oznake sa onim što ste već razgledali.`,
            contribution: Number(contribution.toFixed(4)),
          });
        }
      }

      // Declared interests.
      if (weightOf('interests') > 0 && interestTokens.size > 0) {
        const tags = this.docTags.get(doc.id) ?? new Set();
        let hits = 0;
        for (const token of interestTokens) if (tags.has(token)) hits++;
        if (hits > 0) {
          const contribution = clamp01(hits / interestTokens.size) * weightOf('interests');
          score += contribution;
          reasons.push({
            factor: 'vaša interesovanja',
            detail: 'Odgovara interesovanjima koja ste naveli.',
            contribution: Number(contribution.toFixed(4)),
          });
        }
      }

      // Season, damped by how much the user actually engages with this
      // category. A cold user has nothing to contradict the season, so they
      // get the full boost.
      if (weightOf('season') > 0 && boosted.has(doc.category)) {
        const affinity = categoryAffinity.get(doc.category) ?? 0;
        const damping = strategy === 'cold' ? 1 : 0.3 + 0.7 * affinity;
        const contribution = weightOf('season') * damping;
        score += contribution;
        reasons.push({
          factor: 'godišnje doba',
          detail:
            damping < 1
              ? `Kategorija "${doc.category}" je aktuelna u sezoni "${season}", ali je prigušena jer je van vaših uobičajenih kupovina.`
              : `Kategorija "${doc.category}" je aktuelna u sezoni "${season}".`,
          contribution: Number(contribution.toFixed(4)),
        });
      }

      // Popularity. On a cold start this absorbs most of the redistributed
      // weight from the factors that cannot fire, which is the intended
      // behaviour: with nothing known about the visitor, what other people
      // buy is the best available guess.
      const popularity = clamp01(Math.log1p(doc.views ?? 0) / Math.log1p(this.maxViews));
      const popularityWeight = weightOf('popularity');
      if (popularity > 0 && popularityWeight > 0) {
        const contribution = popularity * popularityWeight;
        score += contribution;
        reasons.push({
          factor: 'popularnost',
          detail: strategy === 'cold'
            ? 'Nemamo istoriju za vas, pa prikazujemo ono što je najtraženije.'
            : 'Dodatno je popularno među ostalim kupcima.',
          contribution: Number(contribution.toFixed(4)),
        });
      }

      // Budget.
      if (weightOf('price') > 0 && request.budget !== undefined && doc.price !== undefined) {
        const fit = doc.price <= request.budget ? 1 : clamp01(1 - (doc.price - request.budget) / request.budget);
        const contribution = fit * weightOf('price');
        score += contribution;
        if (fit < 1) {
          reasons.push({
            factor: 'budžet',
            detail: `Cena ${doc.price} prelazi navedeni budžet ${request.budget}.`,
            contribution: Number(contribution.toFixed(4)),
          });
        }
      }

      if (score <= 0) continue;

      scored.push({
        doc,
        score,
        reasons: reasons.sort((a, b) => b.contribution - a.contribution),
        novel: !historyCategories.has(doc.category),
      });
    }

    scored.sort((a, b) => (b.score - a.score) || a.doc.id.localeCompare(b.doc.id));

    // Reserve part of the slate for categories outside the user's history.
    // Without this the recommender converges on whatever the user already
    // bought and stops discovering anything.
    const topN = this.config.topN;
    const explorationSlots =
      history.length > 0 && this.config.explore > 0
        ? Math.max(1, Math.floor(topN * this.config.explore))
        : 0;

    const familiar = scored.filter((s) => !s.novel);
    const novel = scored.filter((s) => s.novel);

    const selected: typeof scored = [];
    const takeNovel = novel.slice(0, explorationSlots);
    const takeFamiliar = familiar.slice(0, topN - takeNovel.length);

    selected.push(...takeFamiliar, ...takeNovel);
    // Fill any shortfall from whatever is left, preserving global order.
    if (selected.length < topN) {
      const chosen = new Set(selected.map((s) => s.doc.id));
      for (const item of scored) {
        if (selected.length >= topN) break;
        if (!chosen.has(item.doc.id)) selected.push(item);
      }
    }
    selected.sort((a, b) => (b.score - a.score) || a.doc.id.localeCompare(b.doc.id));

    const items: Recommendation[] = selected.slice(0, topN).map((item) => ({
      id: item.doc.id,
      title: item.doc.title,
      category: item.doc.category,
      score: Number(item.score.toFixed(4)),
      reasons: item.reasons,
    }));

    return {
      engine: this.plan.engine,
      strategy,
      season,
      userHistorySize: history.length,
      items,
      stats: {
        candidates: scored.length,
        excludedSeen,
        excludedDismissed,
        exploration: takeNovel.length,
        returned: items.length,
        durationMs: Number((performance.now() - started).toFixed(3)),
      },
    };
  }
}
