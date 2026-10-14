import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { Engine, type Doc } from '../src/runtime/execute.ts';
import { normalize, stem, tokenizeText, overlapScore } from '../src/runtime/text.ts';
import { analyzeContent, buildCorpusShingles } from '../src/runtime/content.ts';
import { seasonOf } from '../src/runtime/intent.ts';
import { LocalEmbedding } from '../src/runtime/embed.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples');

const source = readFileSync(join(examples, 'prodavnica.gs'), 'utf8');
const { plan } = compile(parse(source, 'prodavnica.gs'), source, 'prodavnica.gs');
const docs = JSON.parse(readFileSync(join(examples, 'catalog.json'), 'utf8')) as Doc[];
const engine = await Engine.create(plan, docs, { embedding: new LocalEmbedding() });

const DECEMBER = '2026-12-15T10:00:00Z';
const JULY = '2026-07-15T10:00:00Z';

describe('normalizacija teksta', () => {
  test('ćirilica i latinica se svode na isti oblik', async () => {
    assert.equal(normalize('свећице'), normalize('svećice'));
    assert.equal(normalize('Свећице'), normalize('svecice'));
  });

  test('dijakritici se sklanjaju', async () => {
    // č i ć se oba svode na c, đ na digraf dj.
    assert.equal(normalize('čćšžđ'), 'ccszdj');
  });

  test('normalizacija je idempotentna', async () => {
    for (const word of ['свећице', 'Bašta', 'NGK BKR6E-11', 'džep']) {
      assert.equal(normalize(normalize(word)), normalize(word), `nije idempotentno za "${word}"`);
    }
  });

  test('stopwords se uklanjaju iz tokena', async () => {
    assert.deepEqual(tokenizeText('svećice za Subaru'), ['svecice', 'subaru']);
  });

  test('stemmer spaja padeže iste reči', async () => {
    const forms = ['svecice', 'svecica', 'svecicu', 'svecicama'].map(stem);
    assert.equal(new Set(forms).size, 1, `očekivan jedan stem, dobijeno: ${[...new Set(forms)].join(', ')}`);
  });

  test('stemmer ne skraćuje kratke reči do besmisla', async () => {
    assert.equal(stem('auto'), 'auto');
    assert.equal(stem('led'), 'led');
  });

  test('overlapScore je 0 za prazan upit i 1 za potpuno poklapanje', async () => {
    assert.equal(overlapScore([], ['a']), 0);
    assert.equal(overlapScore(['a', 'b'], ['a', 'b', 'c']), 1);
    assert.equal(overlapScore(['a', 'b'], ['a']), 0.5);
  });
});

describe('godišnja doba', () => {
  test('meseci se mapiraju na ispravno doba', async () => {
    assert.equal(seasonOf(new Date('2026-01-15')), 'zima');
    assert.equal(seasonOf(new Date('2026-04-15')), 'prolece');
    assert.equal(seasonOf(new Date('2026-07-15')), 'leto');
    assert.equal(seasonOf(new Date('2026-10-15')), 'jesen');
    assert.equal(seasonOf(new Date('2026-12-15')), 'zima');
  });
});

describe('razrešavanje namere', () => {
  test('goli upit "svećice" je dvosmislen i traži pojašnjenje', async () => {
    const result = await engine.search({ query: 'svećice', now: DECEMBER });
    assert.equal(result.intent.ambiguous, true);
    assert.equal(result.intent.locked, false);
    assert.ok(result.clarify, 'očekivano pitanje za pojašnjenje');
    assert.ok(result.clarify!.options.length >= 3);
  });

  test('kontekst "Subaru" zaključava nameru na auto-delove', async () => {
    const result = await engine.search({ query: 'svećice za Subaru', now: DECEMBER });
    assert.equal(result.intent.category, 'auto-delovi');
    assert.equal(result.intent.locked, true);
    assert.equal(result.intent.firedRule, 'auto-kontekst');
    assert.equal(result.clarify, null);
  });

  test('kontekst "bašta" zaključava nameru na baštensku rasvetu', async () => {
    const result = await engine.search({ query: 'svećice za baštu', now: JULY });
    assert.equal(result.intent.category, 'bastenska-rasveta');
    assert.equal(result.intent.locked, true);
  });

  test('upit van taksonomije ne proizvodi lažnu nameru', async () => {
    const result = await engine.search({ query: 'kajak na naduvavanje', now: JULY });
    assert.equal(result.intent.category, null);
    assert.equal(result.intent.ambiguous, false);
    assert.deepEqual(result.intent.candidates, []);
  });

  test('ćirilični upit se ponaša identično latiničnom', async () => {
    const latin = await engine.search({ query: 'svećice za Subaru', now: DECEMBER });
    const cyrillic = await engine.search({ query: 'свећице за Субару', now: DECEMBER });
    assert.equal(cyrillic.intent.category, latin.intent.category);
    assert.deepEqual(
      cyrillic.hits.map((h) => h.id),
      latin.hits.map((h) => h.id),
    );
  });
});

describe('zaštita namere — razlog postojanja jezika', () => {
  /**
   * Ovo je regresioni test koji čuva samu svrhu GoSimple-a. Ako ikada padne,
   * jezik je izgubio jedinu osobinu zbog koje postoji umesto običnog
   * Elasticsearch upita.
   */
  test('"svećice za Subaru" u decembru NE vraća nijedan novogodišnji artikal', async () => {
    const result = await engine.search({ query: 'svećice za Subaru', now: DECEMBER });

    assert.equal(result.season, 'zima', 'test mora da se izvršava u zimskom kontekstu');

    const holiday = result.hits.filter((h) => h.category === 'praznicna-dekoracija');
    assert.deepEqual(
      holiday,
      [],
      `sezona je prevagnula nad zaključanom namerom: ${holiday.map((h) => h.title).join(', ')}`,
    );

    assert.equal(result.hits[0]?.category, 'auto-delovi');
    assert.match(result.hits[0]!.title, /NGK|Bosch/);
  });

  test('zaključana namera potiskuje sezonski signal i to je vidljivo u objašnjenju', async () => {
    const result = await engine.search({ query: 'svećice za Subaru', now: DECEMBER });
    const seasonal = result.hits[0]!.signals!.find((s) => s.signal === 'seasonal_relevance')!;

    assert.equal(seasonal.contribution, 0);
    assert.ok(seasonal.suppressed, 'potiskivanje mora biti eksplicitno zabeleženo');
    assert.match(result.hits[0]!.explanation!, /nije uzeta u obzir/);
  });

  test('potisnuta težina se preraspodeljuje, a ne gubi', async () => {
    const locked = await engine.search({ query: 'svećice za Subaru', now: DECEMBER });
    const total = locked.hits[0]!.signals!.reduce((acc, s) => acc + s.weight, 0);
    const declared = plan.search!.rank.reduce((acc, r) => acc + r.weight, 0);

    assert.ok(
      Math.abs(total - declared) < 0.001,
      `zbir efektivnih težina ${total} ne odgovara deklarisanom ${declared}`,
    );
  });

  test('sezona i dalje deluje kada namera NIJE zaključana', async () => {
    const winter = await engine.search({ query: 'svećice', now: DECEMBER });
    const summer = await engine.search({ query: 'svećice', now: JULY });

    assert.equal(winter.hits[0]!.category, 'praznicna-dekoracija');
    assert.equal(summer.hits[0]!.category, 'bastenska-rasveta');
  });

  test('zaključana namera vraća isti skup kategorija u obe sezone', async () => {
    const winter = await engine.search({ query: 'svećice za Subaru', now: DECEMBER });
    const summer = await engine.search({ query: 'svećice za Subaru', now: JULY });

    // Poredak sme minimalno da se razlikuje jer freshness zavisi od vremena,
    // što je namerno. Ono što ne sme da se promeni jeste sastav: nijedan
    // rezultat ne sme da iscuri iz druge kategorije zbog godišnjeg doba.
    assert.deepEqual(
      [...new Set(winter.hits.map((h) => h.category))],
      ['auto-delovi'],
    );
    assert.deepEqual(
      [...new Set(summer.hits.map((h) => h.category))],
      ['auto-delovi'],
    );
    assert.deepEqual(
      winter.hits.map((h) => h.id).sort(),
      summer.hits.map((h) => h.id).sort(),
      'skup rezultata mora biti identičan bez obzira na godišnje doba',
    );
  });

  test('sezonski signal je nula u obe sezone kada je namera zaključana', async () => {
    for (const now of [DECEMBER, JULY]) {
      const result = await engine.search({ query: 'svećice za Subaru', now });
      for (const hit of result.hits) {
        const seasonal = hit.signals!.find((s) => s.signal === 'seasonal_relevance')!;
        assert.equal(seasonal.contribution, 0, `sezona je uticala u ${now}`);
      }
    }
  });
});

describe('pretraga i rangiranje', () => {
  test('nedostupni proizvodi se izbacuju', async () => {
    const result = await engine.search({ query: 'kočione pločice Brembo', now: JULY });
    assert.ok(!result.hits.some((h) => h.id === 'ad-005'), 'nedostupan proizvod je procurio u rezultate');
  });

  test('match faza odbacuje dokumente bez ikakve veze sa upitom', async () => {
    const result = await engine.search({ query: 'svećice za Subaru', now: DECEMBER });
    assert.ok(
      result.hits.every((h) => h.category === 'auto-delovi'),
      `nerelevantne kategorije u rezultatu: ${result.hits.map((h) => h.category).join(', ')}`,
    );
  });

  test('izvršavanje je determinističko', async () => {
    const a = await engine.search({ query: 'svećice', now: DECEMBER });
    const b = await engine.search({ query: 'svećice', now: DECEMBER });
    assert.deepEqual(
      a.hits.map((h) => [h.id, h.score]),
      b.hits.map((h) => [h.id, h.score]),
    );
  });

  test('rezultati nikad ne prelaze return top', async () => {
    const result = await engine.search({ query: 'svećice', now: DECEMBER });
    assert.ok(result.hits.length <= plan.search!.topN);
  });

  test('skorovi su u opsegu [0, 1] i opadaju', async () => {
    const result = await engine.search({ query: 'svećice', now: DECEMBER });
    for (const hit of result.hits) {
      assert.ok(hit.score >= 0 && hit.score <= 1, `skor van opsega: ${hit.score}`);
    }
    for (let i = 1; i < result.hits.length; i++) {
      assert.ok(result.hits[i - 1]!.score >= result.hits[i]!.score, 'rezultati nisu sortirani opadajuće');
    }
  });

  test('diverzifikacija ograničava broj po kategoriji u gornjem delu liste', async () => {
    const result = await engine.search({ query: 'sijalica', now: JULY });
    const max = plan.search!.diversify!.max;
    const counts = new Map<string, number>();
    for (const hit of result.hits.slice(0, max * 2)) {
      counts.set(hit.category, (counts.get(hit.category) ?? 0) + 1);
    }
    for (const [category, count] of counts) {
      assert.ok(count <= max + 1, `kategorija "${category}" se pojavila ${count} puta`);
    }
  });

  test('prazan upit ne ruši runtime', async () => {
    const result = await engine.search({ query: '', now: JULY });
    assert.equal(result.hits.length, 0);
    assert.equal(result.intent.category, null);
  });

  test('budžet korisnika utiče na price_fit bez rušenja kada cena nedostaje', async () => {
    const result = await engine.search({ query: 'svećice za Subaru', user: { budget: 2000 }, now: JULY });
    assert.ok(result.hits.length > 0);
  });
});

describe('analiza sadržaja', () => {
  test('dva skoro identična opisa se prepoznaju kao duplikati', async () => {
    const report = engine.contentFor('br-003');
    assert.ok(report, 'očekivan izveštaj za br-003');
    assert.ok(
      report!.features.duplication > 0.4,
      `očekivano visoko poklapanje, dobijeno ${report!.features.duplication.toFixed(2)}`,
    );
    assert.ok(report!.templateLikeness.evidence.some((e) => e.feature === 'duplication'));
  });

  test('konkretan tehnički opis ima viši kvalitet od marketinškog', async () => {
    const technical = engine.contentFor('ad-001')!;
    const marketing = engine.contentFor('br-003')!;
    assert.ok(
      technical.quality > marketing.quality,
      `tehnički ${technical.quality.toFixed(2)} nije iznad marketinškog ${marketing.quality.toFixed(2)}`,
    );
  });

  test('originalnost je obrnuto proporcionalna poklapanju', async () => {
    const report = engine.contentFor('br-003')!;
    assert.ok(Math.abs(report.originality - (1 - report.features.duplication)) < 0.001);
  });

  test('kratak tekst daje nisku pouzdanost umesto lažne presude', async () => {
    const report = analyzeContent('Crvena stolica.', []);
    assert.ok(
      report.templateLikeness.confidence < 0.2,
      `pouzdanost ${report.templateLikeness.confidence} je previsoka za tri reči`,
    );
  });

  test('analiza nikada ne tvrdi autorstvo, samo iznosi dokaze', async () => {
    const report = analyzeContent(
      'Kvalitetno rešenje. Vrhunski materijali. Moderan dizajn. Pouzdan rad. Idealan izbor.',
      buildCorpusShingles(['nepovezan tekst o nečemu drugom']),
    );
    assert.ok(report.templateLikeness.score > 0);
    for (const evidence of report.templateLikeness.evidence) {
      assert.ok(typeof evidence.observation === 'string' && evidence.observation.length > 0);
      assert.doesNotMatch(evidence.observation, /napisao .*AI|generisano veštačkom/i);
    }
  });

  test('prazan tekst ne ruši analizu', async () => {
    const report = analyzeContent('', []);
    assert.equal(report.features.tokenCount, 0);
    assert.equal(report.templateLikeness.confidence, 0);
  });
});
