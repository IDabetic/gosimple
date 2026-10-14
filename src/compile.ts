/**
 * Semantic checking and lowering from AST to IR.
 *
 * The checker enforces the invariants the runtime depends on, so the runtime
 * never has to defend against a malformed plan. The most important one is
 * GS2008: a program may not ask for `protect intent` without declaring an
 * intent to protect — that silent no-op is exactly the bug that would send a
 * shopper looking for spark plugs to the Christmas lights aisle.
 */

import type { EngineDecl, EventsDecl, IntentDecl, Program, SourceDecl, TaxonomyDecl } from './ast.ts';
import { GoSimpleError, suggest, type Diagnostic } from './diagnostics.ts';
import {
  RECOMMEND_FACTORS,
  DEFAULT_FACTOR_WEIGHTS,
  HISTORY_DEPENDENT_FACTORS,
  type RecommendFactor,
  ANALYZE_CHECKS,
  DIVERSIFY_FIELDS,
  DOC_FIELDS,
  IR_VERSION,
  LEARN_EVENTS,
  MATCH_FIELDS,
  RANK_SIGNALS,
  REQUIRED_DOC_FIELDS,
  type IRCategory,
  type IRSource,
  type MatchField,
  type Plan,
  type RankSignal,
} from './ir.ts';
import { normalize, stem } from './runtime/text.ts';
import { columnsOf, parseWhere, WhereParseError } from './sources/where.ts';

export type CompileResult = {
  plan: Plan;
  warnings: Diagnostic[];
};

export function compile(program: Program, source: string, file = '<memory>'): CompileResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  const error = (code: string, message: string, span: { line: number; col: number }, hint?: string) => {
    const d: Diagnostic = { severity: 'error', code, message, span };
    if (hint) d.hint = hint;
    errors.push(d);
  };
  const warn = (code: string, message: string, span: { line: number; col: number }, hint?: string) => {
    const d: Diagnostic = { severity: 'warning', code, message, span };
    if (hint) d.hint = hint;
    warnings.push(d);
  };

  const sources = program.decls.filter((d): d is SourceDecl => d.kind === 'source');
  const eventDecls = program.decls.filter((d): d is EventsDecl => d.kind === 'events');

  if (eventDecls.length > 1) {
    error(
      'GS2024',
      `Deklarisano je ${eventDecls.length} dnevnika događaja; dozvoljen je najviše jedan`,
      eventDecls[1]!.span,
    );
  }
  const eventsDecl = eventDecls[0] ?? null;

  // --- Source validation --------------------------------------------------
  // SQL identifiers cannot be bound as query parameters, so the only safe
  // handling is a strict allowlist plus quoting at query-build time. Anything
  // that is not a plain identifier is rejected here, at compile time, rather
  // than being escaped and hoped for at runtime.
  const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

  for (const decl of sources) {
    const isSql = /^postgres(ql)?:\/\//i.test(decl.uri);

    for (const [field, column] of Object.entries(decl.columns)) {
      if (!(DOC_FIELDS as readonly string[]).includes(field)) {
        const hint = suggest(field, DOC_FIELDS);
        error(
          'GS2040',
          `Nepoznato polje dokumenta "${field}" u map bloku`,
          decl.span,
          hint ? `Da li ste mislili "${hint}"?` : `Dostupno: ${DOC_FIELDS.join(', ')}.`,
        );
      }
      if (isSql && !SAFE_IDENTIFIER.test(column)) {
        error(
          'GS2043',
          `Naziv kolone "${column}" nije ispravan SQL identifikator`,
          decl.span,
          'Dozvoljena su slova, cifre i donja crta, uz početak slovom. Preimenujte kolonu ili koristite view.',
        );
      }
    }

    if (isSql) {
      if (decl.table === null) {
        error(
          'GS2041',
          `SQL izvor "${decl.name}" nema navedenu tabelu`,
          decl.span,
          'Dodajte `table "naziv_tabele"` u blok izvora.',
        );
      } else if (!SAFE_IDENTIFIER.test(decl.table)) {
        error(
          'GS2043',
          `Naziv tabele "${decl.table}" nije ispravan SQL identifikator`,
          decl.span,
          'Dozvoljena su slova, cifre i donja crta, uz početak slovom.',
        );
      }

      for (const field of REQUIRED_DOC_FIELDS) {
        if (decl.columns[field] === undefined) {
          error(
            'GS2044',
            `SQL izvor "${decl.name}" ne mapira obavezno polje "${field}"`,
            decl.span,
            `Dodajte \`${field} "naziv_kolone"\` u map blok.`,
          );
        }
      }

      // The where clause is parsed here, not pattern-matched. A blocklist on
      // SQL does not hold: `false UNION SELECT password_hash FROM users`
      // contains no forbidden character and was shown to exfiltrate another
      // table. Only an expression the grammar can fully represent is allowed
      // through, and failing at compile time beats failing in production.
      if (decl.where !== null) {
        try {
          const expr = parseWhere(decl.where);

          // A where clause that reads no column at all is almost always a
          // mistake — `where "true"` filters nothing and `where "false"`
          // empties the catalogue silently.
          if (columnsOf(expr).length === 0) {
            warn(
              'GS2110',
              `where uslov izvora "${decl.name}" ne pominje nijednu kolonu`,
              decl.span,
              'Takav uslov je konstanta: ili ne filtrira ništa, ili prazni ceo katalog.',
            );
          }
        } catch (err) {
          if (err instanceof WhereParseError) {
            error('GS2042', `Neispravan where uslov: ${err.message}`, decl.span, err.hint);
          } else {
            throw err;
          }
        }
      }

      if (decl.limit !== null && decl.limit <= 0) {
        error('GS2045', `limit mora biti pozitivan, dato ${decl.limit}`, decl.span);
      }

      // A `.gs` file is source code and goes into git. A connection string
      // written out in full takes the password with it, where it outlives
      // every rotation and shows up in every clone.
      const credentials = /:\/\/[^/@\s]*:[^/@\s]+@/.exec(decl.uri);
      if (credentials && !credentials[0].includes('${')) {
        warn(
          'GS2111',
          `Konekcioni string izvora "${decl.name}" sadrži lozinku`,
          decl.span,
          'Koristite ${PROMENLJIVA} — vrednost se čita iz okruženja pri pokretanju i ne ulazi ni u fajl ni u IR plan.',
        );
      }
    } else if (decl.table !== null || Object.keys(decl.columns).length > 0) {
      warn(
        'GS2106',
        `Izvor "${decl.name}" nije SQL, pa se table i map ignorišu`,
        decl.span,
        'JSON izvor mora već da koristi nazive polja GoSimple dokumenta.',
      );
    }
  }

  const taxonomies = program.decls.filter((d): d is TaxonomyDecl => d.kind === 'taxonomy');
  const intents = program.decls.filter((d): d is IntentDecl => d.kind === 'intent');
  const engines = program.decls.filter((d): d is EngineDecl => d.kind === 'engine');

  if (engines.length === 0) {
    error('GS2014', 'Program ne sadrži nijedan engine blok', { line: 1, col: 1 }, 'Dodajte `engine Ime { search { ... } }`.');
    throw new GoSimpleError(errors, source, file);
  }
  if (engines.length > 1) {
    error(
      'GS2016',
      `Pronađeno ${engines.length} engine blokova; v0.1 podržava tačno jedan po fajlu`,
      engines[1]!.span,
      'Razdvojite ih u zasebne .gs fajlove.',
    );
  }

  // --- Taxonomy -----------------------------------------------------------
  const categories: IRCategory[] = [];
  const seenCategories = new Map<string, { line: number; col: number }>();

  for (const taxonomy of taxonomies) {
    for (const category of taxonomy.categories) {
      const previous = seenCategories.get(category.name);
      if (previous) {
        error(
          'GS2011',
          `Kategorija "${category.name}" je već definisana na liniji ${previous.line}`,
          category.span,
          'Spojite obe definicije u jednu ili preimenujte jednu od njih.',
        );
        continue;
      }
      seenCategories.set(category.name, category.span);

      if (category.terms.length === 0) {
        warn(
          'GS2101',
          `Kategorija "${category.name}" nema nijedan term`,
          category.span,
          'Bez terms kategorija nikada neće biti pronađena preko upita.',
        );
      }
      categories.push({
        name: category.name,
        terms: category.terms,
        signals: category.signals,
        seasons: category.seasons,
      });
    }
  }

  const categoryNames = categories.map((c) => c.name);

  // --- Intent -------------------------------------------------------------
  const intentByName = new Map(intents.map((i) => [i.name, i]));

  for (const intent of intents) {
    if (intent.ambiguousBelow < 0 || intent.ambiguousBelow > 1) {
      error(
        'GS2007',
        `Prag pouzdanosti mora biti između 0 i 1, dato ${intent.ambiguousBelow}`,
        intent.span,
      );
    }
    for (const rule of intent.rules) {
      for (const [label, name] of [
        ['when signal of', rule.whenSignalOf],
        ['then category', rule.thenCategory],
      ] as const) {
        if (!categoryNames.includes(name)) {
          const hint = suggest(name, categoryNames);
          error(
            'GS2003',
            `Pravilo "${rule.name}" (${label}) referencira nepostojeću kategoriju "${name}"`,
            rule.span,
            hint ? `Da li ste mislili "${hint}"?` : `Definisane kategorije: ${categoryNames.join(', ') || '(nijedna)'}.`,
          );
        }
      }
      if (rule.confidence < 0 || rule.confidence > 1) {
        error('GS2007', `confidence mora biti između 0 i 1, dato ${rule.confidence}`, rule.span);
      }

      // A rule that keys off a category with no signals can never fire.
      const keyed = categories.find((c) => c.name === rule.whenSignalOf);
      if (keyed && keyed.signals.length === 0) {
        warn(
          'GS2102',
          `Pravilo "${rule.name}" se oslanja na signale kategorije "${rule.whenSignalOf}", koja nema nijedan signal`,
          rule.span,
          'Dodajte `signals [...]` u tu kategoriju, inače se pravilo nikada neće aktivirati.',
        );
      }
    }
  }

  // --- Engine -------------------------------------------------------------
  const engine = engines[0]!;

  const toIRSource = (decl: SourceDecl): IRSource => ({
    name: decl.name,
    uri: decl.uri,
    table: decl.table,
    columns: decl.columns,
    where: decl.where,
    limit: decl.limit,
  });
  const emptySource = (name: string): IRSource => ({
    name,
    uri: '',
    table: null,
    columns: {},
    where: null,
    limit: null,
  });

  let resolvedSource: IRSource;
  if (engine.useSource === null) {
    if (sources.length === 1) {
      resolvedSource = toIRSource(sources[0]!);
    } else if (sources.length === 0) {
      error('GS2001', 'Nije deklarisan nijedan izvor podataka', engine.span, 'Dodajte `source products from "catalog.json"`.');
      resolvedSource = emptySource('unknown');
    } else {
      error(
        'GS2001',
        `Deklarisano je ${sources.length} izvora; engine mora da izabere jedan`,
        engine.span,
        `Dodajte "use source <ime>" u engine blok. Dostupno: ${sources.map((s) => s.name).join(', ')}.`,
      );
      resolvedSource = toIRSource(sources[0]!);
    }
  } else {
    const found = sources.find((s) => s.name === engine.useSource);
    if (!found) {
      const hint = suggest(engine.useSource, sources.map((s) => s.name));
      error(
        'GS2001',
        `Engine referencira nepostojeći izvor "${engine.useSource}"`,
        engine.span,
        hint ? `Da li ste mislili "${hint}"?` : undefined,
      );
      resolvedSource = emptySource(engine.useSource);
    } else {
      resolvedSource = toIRSource(found);
    }
  }

  let resolvedIntent: IntentDecl | null = null;
  if (engine.useIntent !== null) {
    const found = intentByName.get(engine.useIntent);
    if (!found) {
      const hint = suggest(engine.useIntent, [...intentByName.keys()]);
      error(
        'GS2002',
        `Engine referencira nepostojeći intent "${engine.useIntent}"`,
        engine.span,
        hint ? `Da li ste mislili "${hint}"?` : undefined,
      );
    } else {
      resolvedIntent = found;
    }
  } else if (intents.length === 1) {
    resolvedIntent = intents[0]!;
  }

  // --- Search block -------------------------------------------------------
  let irSearch: Plan['search'] = null;

  if (engine.search) {
    const s = engine.search;

    if (s.retrieve < s.topN) {
      error(
        'GS2010',
        `retrieve (${s.retrieve}) je manji od return top (${s.topN})`,
        s.span,
        'Ne možete vratiti više rezultata nego što ste dovukli kandidata.',
      );
    }
    if (s.retrieve <= 0) {
      error('GS2010', `retrieve mora biti pozitivan, dato ${s.retrieve}`, s.span);
    }

    // match fields
    const match: Array<{ field: MatchField; weight: number }> = [];
    const seenMatch = new Set<string>();
    for (const clause of s.match) {
      if (!(MATCH_FIELDS as readonly string[]).includes(clause.field)) {
        const hint = suggest(clause.field, MATCH_FIELDS);
        error(
          'GS2005',
          `Nepoznato match polje "${clause.field}"`,
          clause.span,
          hint ? `Da li ste mislili "${hint}"?` : `Dostupno: ${MATCH_FIELDS.join(', ')}.`,
        );
        continue;
      }
      if (seenMatch.has(clause.field)) {
        error('GS2013', `match polje "${clause.field}" je navedeno više puta`, clause.span);
        continue;
      }
      if (clause.weight < 0) {
        error('GS2015', `Težina ne sme biti negativna, dato ${clause.weight}`, clause.span);
      }
      if (clause.field === 'semantic') {
        warn(
          'GS2105',
          'match polje "semantic" zavisi od embedding provajdera izabranog u okruženju',
          clause.span,
          'Podrazumevani "local" provajder hvata sličnost oblika reči, ali ne i značenje. ' +
            'Za stvarno razumevanje značenja postavite GOSIMPLE_EMBEDDING=openai. ' +
            'Odgovor pretrage uvek navodi koji je režim bio aktivan (vectorMode).',
        );
      }
      seenMatch.add(clause.field);
      match.push({ field: clause.field as MatchField, weight: clause.weight });
    }
    if (match.length === 0) {
      error('GS2005', 'search blok nema nijedno match polje', s.span, 'Dodajte `match { keywords weight 1.0 }`.');
    }

    // rank signals
    const rank: Array<{ signal: RankSignal; weight: number }> = [];
    const seenRank = new Set<string>();
    for (const clause of s.rank) {
      if (!(RANK_SIGNALS as readonly string[]).includes(clause.signal)) {
        const hint = suggest(clause.signal, RANK_SIGNALS);
        error(
          'GS2004',
          `Nepoznat rank signal "${clause.signal}"`,
          clause.span,
          hint ? `Da li ste mislili "${hint}"?` : `Dostupno: ${RANK_SIGNALS.join(', ')}.`,
        );
        continue;
      }
      if (seenRank.has(clause.signal)) {
        error('GS2013', `rank signal "${clause.signal}" je naveden više puta`, clause.span);
        continue;
      }
      if (clause.weight < 0) {
        error('GS2015', `Težina ne sme biti negativna, dato ${clause.weight}`, clause.span);
      }
      seenRank.add(clause.signal);
      rank.push({ signal: clause.signal as RankSignal, weight: clause.weight });
    }
    if (rank.length === 0) {
      error('GS2004', 'search blok nema nijedan rank signal', s.span, 'Dodajte `rank by { query_relevance 1.0 }`.');
    }

    const weightSum = rank.reduce((acc, r) => acc + r.weight, 0);
    if (rank.length > 0 && Math.abs(weightSum - 1) > 0.001) {
      warn(
        'GS2006',
        `Zbir rank težina je ${weightSum.toFixed(3)}, a ne 1.0`,
        s.span,
        'Težine će biti normalizovane pri izvršavanju, ali eksplicitan zbir 1.0 čini pravila čitljivijim.',
      );
    }

    // protect intent requires an intent
    if (s.protectIntent && resolvedIntent === null) {
      error(
        'GS2008',
        '`protect intent` je traženo, ali engine nema intent',
        s.span,
        'Deklarišite `intent Ime { ... }` i povežite ga sa `use intent Ime`. Bez toga sezonski signali mogu da preusmere nameru korisnika.',
      );
    }

    // seasonal_relevance without declared seasons is dead weight
    const usesSeasonal = rank.some((r) => r.signal === 'seasonal_relevance' && r.weight > 0);
    const anySeasons = categories.some((c) => c.seasons.length > 0);
    if (usesSeasonal && !anySeasons) {
      warn(
        'GS2009',
        'seasonal_relevance ima težinu, ali nijedna kategorija nema deklarisano godišnje doba',
        s.span,
        'Dodajte `season [leto]` u odgovarajuće kategorije, inače je ovaj signal uvek nula.',
      );
    }

    // seasonal signal without protection is the spark-plug bug waiting to happen
    if (usesSeasonal && !s.protectIntent) {
      warn(
        'GS2103',
        'seasonal_relevance se koristi bez `protect intent`',
        s.span,
        'Sezonski signal tada može da potisne eksplicitnu nameru korisnika (npr. "svećice za Subaru" u decembru).',
      );
    }

    if (s.diversify && !(DIVERSIFY_FIELDS as readonly string[]).includes(s.diversify.field)) {
      const hint = suggest(s.diversify.field, DIVERSIFY_FIELDS);
      error(
        'GS2012',
        `Nepoznato diversify polje "${s.diversify.field}"`,
        s.span,
        hint ? `Da li ste mislili "${hint}"?` : `Dostupno: ${DIVERSIFY_FIELDS.join(', ')}.`,
      );
    }
    if (s.diversify && s.diversify.max <= 0) {
      error('GS2012', `diversify max mora biti pozitivan, dato ${s.diversify.max}`, s.span);
    }

    irSearch = {
      retrieve: s.retrieve,
      match,
      rank,
      protectIntent: s.protectIntent,
      diversify: s.diversify,
      excludeUnavailable: s.excludeUnavailable,
      explain: s.explain,
      topN: s.topN,
    };
  }

  // --- Recommend block ----------------------------------------------------
  let irRecommend: Plan['recommend'] = null;
  if (engine.recommend) {
    const r = engine.recommend;
    for (const event of r.learnFrom) {
      if (!(LEARN_EVENTS as readonly string[]).includes(event)) {
        const hint = suggest(event, LEARN_EVENTS);
        error(
          'GS2020',
          `Nepoznat događaj "${event}" u learn from`,
          r.span,
          hint ? `Da li ste mislili "${hint}"?` : `Dostupno: ${LEARN_EVENTS.join(', ')}.`,
        );
      }
    }
    // Factors arrive either as `account for [...]` (default weights) or as
    // `factors { ... }` (explicit weights). Accepting both at once would mean
    // guessing which one wins, so it is rejected instead.
    if (r.accountFor.length > 0 && r.factors.length > 0) {
      error(
        'GS2025',
        'recommend blok koristi i "account for" i "factors"',
        r.span,
        'Zadržite jedno: "account for" za podrazumevane težine, "factors" kada želite da ih sami zadate.',
      );
    }

    const weights: Partial<Record<RecommendFactor, number>> = {};

    for (const factor of r.accountFor) {
      if (!(RECOMMEND_FACTORS as readonly string[]).includes(factor)) {
        const hint = suggest(factor, RECOMMEND_FACTORS);
        error(
          'GS2021',
          `Nepoznat faktor "${factor}" u account for`,
          r.span,
          hint ? `Da li ste mislili "${hint}"?` : `Dostupno: ${RECOMMEND_FACTORS.join(', ')}.`,
        );
        continue;
      }
      const name = factor as RecommendFactor;
      weights[name] = DEFAULT_FACTOR_WEIGHTS[name];
    }

    const seenFactors = new Set<string>();
    for (const clause of r.factors) {
      if (!(RECOMMEND_FACTORS as readonly string[]).includes(clause.factor)) {
        const hint = suggest(clause.factor, RECOMMEND_FACTORS);
        error(
          'GS2021',
          `Nepoznat faktor "${clause.factor}" u factors bloku`,
          clause.span,
          hint ? `Da li ste mislili "${hint}"?` : `Dostupno: ${RECOMMEND_FACTORS.join(', ')}.`,
        );
        continue;
      }
      if (seenFactors.has(clause.factor)) {
        error('GS2026', `Faktor "${clause.factor}" je naveden više puta`, clause.span);
        continue;
      }
      seenFactors.add(clause.factor);

      if (clause.weight <= 0 || clause.weight > 1) {
        error(
          'GS2027',
          `Težina faktora "${clause.factor}" mora biti između 0 i 1, dato ${clause.weight}`,
          clause.span,
          'Težine su relativne; zbir ne mora da bude tačno 1, ali svaka mora da bude smislen udeo.',
        );
        continue;
      }
      weights[clause.factor as RecommendFactor] = clause.weight;
    }

    if (Object.keys(weights).length === 0) {
      warn(
        'GS2108',
        'recommend blok nema nijedan faktor',
        r.span,
        `Dodajte \`account for [${RECOMMEND_FACTORS.slice(0, 3).join(', ')}]\` ili \`factors { ... }\`.`,
      );
    }

    // A slate built only from history-dependent factors collapses to nothing
    // for a first-time visitor, which is exactly when recommendations matter
    // most.
    const hasColdStartFactor = (Object.keys(weights) as RecommendFactor[]).some(
      (f) => !HISTORY_DEPENDENT_FACTORS.includes(f),
    );
    if (Object.keys(weights).length > 0 && !hasColdStartFactor) {
      warn(
        'GS2109',
        'svi faktori zavise od istorije korisnika, pa novi posetilac ne dobija ništa',
        r.span,
        'Dodajte "popularity" ili "season" da bi cold start imao od čega da krene.',
      );
    }

    let explore = r.explore ?? 0.25;
    if (r.explore !== null && (r.explore < 0 || r.explore >= 1)) {
      error(
        'GS2028',
        `explore mora biti između 0 i 1, dato ${r.explore}`,
        r.span,
        'To je udeo liste rezervisan za kategorije van istorije korisnika; 0.25 je razuman početak.',
      );
      explore = 0.25;
    }

    if (r.topN <= 0) error('GS2022', `return top mora biti pozitivan, dato ${r.topN}`, r.span);

    if (r.learnFrom.length === 0) {
      warn(
        'GS2107',
        'recommend blok nema "learn from", pa se ponašanje korisnika ne koristi',
        r.span,
        'Bez toga preporuke se svode na popularnost i sezonu. Dodajte `learn from [views, purchases]`.',
      );
    } else if (eventsDecl === null) {
      error(
        'GS2023',
        'recommend blok uči iz događaja, ali dnevnik događaja nije deklarisan',
        r.span,
        'Dodajte `events from "events.json"` na vrh programa.',
      );
    }

    irRecommend = {
      learnFrom: r.learnFrom,
      factors: weights,
      explore,
      excludeRecentlySeen: r.excludeRecentlySeen,
      topN: r.topN,
    };
  }

  // --- Content block ------------------------------------------------------
  let irContent: Plan['content'] = null;
  if (engine.content) {
    const c = engine.content;
    for (const check of c.analyze) {
      if (!(ANALYZE_CHECKS as readonly string[]).includes(check)) {
        const hint = suggest(check, ANALYZE_CHECKS);
        error(
          'GS2030',
          `Nepoznata analiza "${check}"`,
          c.span,
          hint ? `Da li ste mislili "${hint}"?` : `Dostupno: ${ANALYZE_CHECKS.join(', ')}.`,
        );
      }
    }
    for (const score of c.scores) {
      if (score !== 'quality' && score !== 'originality') {
        const hint = suggest(score, ['quality', 'originality']);
        error('GS2031', `Nepoznat score "${score}"`, c.span, hint ? `Da li ste mislili "${hint}"?` : undefined);
      }
    }
    irContent = { analyze: c.analyze, scores: c.scores };
  }

  if (engine.search === null && engine.recommend === null && engine.content === null) {
    error('GS2017', `Engine "${engine.name}" je prazan`, engine.span, 'Dodajte bar jedan od blokova: search, recommend, content.');
  }

  if (errors.length > 0) {
    throw new GoSimpleError([...errors, ...warnings], source, file);
  }

  // --- Lowering: build inverted indexes ----------------------------------
  const termToCategories: Record<string, string[]> = {};
  const signalToCategory: Record<string, string> = {};
  const seasonToCategories: Record<string, string[]> = {};

  for (const category of categories) {
    for (const term of category.terms) {
      // Index both the normalized and stemmed form so inflections resolve.
      for (const key of new Set([normalize(term), stem(normalize(term))])) {
        (termToCategories[key] ??= []).push(category.name);
      }
    }
    for (const signal of category.signals) {
      const key = normalize(signal);
      if (signalToCategory[key] !== undefined && signalToCategory[key] !== category.name) {
        warn(
          'GS2104',
          `Signal "${signal}" pripada i kategoriji "${signalToCategory[key]}" i "${category.name}"`,
          seenCategories.get(category.name) ?? { line: 1, col: 1 },
          'Dvosmislen signal ne može pouzdano da zaključa nameru; uklonite ga iz jedne od kategorija.',
        );
      }
      signalToCategory[key] = category.name;
      // Stemmed form too, so "bašte" matches the signal "bašta".
      const stemmed = stem(key);
      if (signalToCategory[stemmed] === undefined) signalToCategory[stemmed] = category.name;
    }
    for (const season of category.seasons) {
      (seasonToCategories[season] ??= []).push(category.name);
    }
  }

  // Deduplicate category lists produced by the normalize/stem double-indexing.
  for (const key of Object.keys(termToCategories)) {
    termToCategories[key] = [...new Set(termToCategories[key]!)];
  }

  const plan: Plan = {
    irVersion: IR_VERSION,
    engine: engine.name,
    source: resolvedSource,
    events: eventsDecl ? { uri: eventsDecl.uri } : null,
    categories,
    intent: resolvedIntent
      ? {
          name: resolvedIntent.name,
          rules: resolvedIntent.rules.map((r) => ({
            name: r.name,
            whenSignalOf: r.whenSignalOf,
            thenCategory: r.thenCategory,
            confidence: r.confidence,
            lock: r.lock,
          })),
          ambiguousBelow: resolvedIntent.ambiguousBelow,
        }
      : null,
    search: irSearch,
    recommend: irRecommend,
    content: irContent,
    indexes: { termToCategories, signalToCategory, seasonToCategories },
  };

  return { plan, warnings };
}
