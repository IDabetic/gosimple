import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { GoSimpleError } from '../src/diagnostics.ts';
import type { Doc } from '../src/runtime/execute.ts';
import { EventValidationError, parseEvents, Recommender, type Event } from '../src/runtime/recommend.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples');

const source = readFileSync(join(examples, 'prodavnica.gs'), 'utf8');
const { plan } = compile(parse(source, 'prodavnica.gs'), source, 'prodavnica.gs');
const docs = JSON.parse(readFileSync(join(examples, 'catalog.json'), 'utf8')) as Doc[];
const events = parseEvents(JSON.parse(readFileSync(join(examples, 'events.json'), 'utf8')));

const recommender = new Recommender(plan, docs, events);

const DECEMBER = '2026-12-15T10:00:00Z';
const JULY = '2026-07-15T10:00:00Z';

describe('validacija događaja', () => {
  test('ispravan dnevnik se učitava', () => {
    assert.ok(events.length > 30);
    assert.ok(events.every((e) => e.userId && e.docId && e.type));
  });

  test('prihvata i snake_case nazive polja', () => {
    const parsed = parseEvents([{ user_id: 'u1', product_id: 'ad-001', event: 'views' }]);
    assert.equal(parsed[0]!.userId, 'u1');
    assert.equal(parsed[0]!.docId, 'ad-001');
  });

  test('nepoznat tip događaja se odbija sa spiskom dozvoljenih', () => {
    assert.throws(
      () => parseEvents([{ userId: 'u1', docId: 'd1', type: 'teleportacija' }]),
      /views, clicks/,
    );
  });

  test('događaj bez korisnika se odbija', () => {
    assert.throws(() => parseEvents([{ docId: 'd1', type: 'views' }]), EventValidationError);
  });

  test('dnevnik koji nije niz se odbija', () => {
    assert.throws(() => parseEvents({ nije: 'niz' }), EventValidationError);
  });
});

describe('izbor strategije', () => {
  test('korisnik sa istorijom dobija personalizovane preporuke', () => {
    const result = recommender.recommend({ userId: 'u1', now: DECEMBER });
    assert.equal(result.strategy, 'warm');
    assert.ok(result.userHistorySize > 0);
  });

  test('nepoznat korisnik bez seeda pada na popularnost', () => {
    const result = recommender.recommend({ userId: 'niko', now: DECEMBER });
    assert.equal(result.strategy, 'cold');
    assert.equal(result.userHistorySize, 0);
    assert.ok(result.items.length > 0, 'cold start mora da vrati nešto');
  });

  test('nepoznat korisnik sa seedom dobija "slično ovome"', () => {
    const result = recommender.recommend({ userId: 'niko', seedIds: ['ad-001'], now: DECEMBER });
    assert.equal(result.strategy, 'cool');
  });

  test('strategija je uvek vidljiva u odgovoru, nikad prećutana', () => {
    for (const request of [{ userId: 'u1' }, { userId: 'niko' }, { seedIds: ['br-001'] }]) {
      const result = recommender.recommend({ ...request, now: JULY });
      assert.ok(['warm', 'cool', 'cold'].includes(result.strategy));
    }
  });
});

describe('zajedničko ponašanje', () => {
  test('artikli koje su gledali isti kupci se preporučuju', () => {
    // u2 je gledao i ad-001 i ad-003, pa ad-003 treba da stigne do u1,
    // koji je gledao ad-001.
    const result = recommender.recommend({ userId: 'u1', now: JULY });
    const bobina = result.items.find((i) => i.id === 'ad-003');

    assert.ok(bobina, 'ad-003 nije preporučen korisniku u1');
    assert.ok(
      bobina!.reasons.some((r) => r.factor === 'zajedničko ponašanje'),
      `očekivan kolaborativni razlog, dobijeni: ${bobina!.reasons.map((r) => r.factor).join(', ')}`,
    );
  });

  test('popularnost se normalizuje, pa bestseler ne dominira svime', () => {
    // kr-001 ima daleko najviše pregleda u katalogu. Ne sme da bude prvi
    // kod korisnika sa jasnom istorijom u drugoj kategoriji.
    const result = recommender.recommend({ userId: 'u4', now: JULY });
    assert.notEqual(result.items[0]?.id, 'kr-001');
  });

  test('preporuke su determinističke', () => {
    const a = recommender.recommend({ userId: 'u1', now: DECEMBER });
    const b = recommender.recommend({ userId: 'u1', now: DECEMBER });
    assert.deepEqual(
      a.items.map((i) => [i.id, i.score]),
      b.items.map((i) => [i.id, i.score]),
    );
  });
});

describe('izbacivanje i odbijanje', () => {
  test('već viđeni artikli se ne preporučuju ponovo', () => {
    const result = recommender.recommend({ userId: 'u1', now: JULY });
    // u1 je gledao ad-001, ad-002 i ad-004.
    for (const seen of ['ad-001', 'ad-002', 'ad-004']) {
      assert.ok(!result.items.some((i) => i.id === seen), `${seen} je preporučen iako je već viđen`);
    }
    assert.ok(result.stats.excludedSeen >= 3);
  });

  test('eksplicitno odbijen artikal se ne vraća', () => {
    // u5 je odbio br-003.
    const result = recommender.recommend({ userId: 'u5', now: JULY });
    assert.ok(!result.items.some((i) => i.id === 'br-003'));
    assert.ok(result.stats.excludedDismissed > 0);
  });

  test('excludeIds iz zahteva se poštuje', () => {
    const baseline = recommender.recommend({ userId: 'u1', now: JULY });
    const first = baseline.items[0]!.id;
    const filtered = recommender.recommend({ userId: 'u1', excludeIds: [first], now: JULY });
    assert.ok(!filtered.items.some((i) => i.id === first));
  });

  test('nedostupni proizvodi se nikada ne preporučuju', () => {
    for (const userId of ['u1', 'u2', 'u3', 'niko']) {
      const result = recommender.recommend({ userId, now: JULY });
      assert.ok(!result.items.some((i) => i.id === 'ad-005'), `nedostupan artikal kod ${userId}`);
    }
  });
});

describe('sezona prigušena afinitetom', () => {
  /**
   * Isti problem kao kod pretrage, samo kroz druga vrata: kupac koji kupuje
   * isključivo auto-delove ne sme u decembru da dobije novogodišnje ukrase
   * na prvom mestu samo zato što je zima.
   */
  test('kupac auto-delova u decembru ne dobija ukras na prvom mestu', () => {
    const result = recommender.recommend({ userId: 'u1', now: DECEMBER });
    assert.equal(result.season, 'zima');
    assert.notEqual(
      result.items[0]?.category,
      'praznicna-dekoracija',
      `prvi rezultat je "${result.items[0]?.title}"`,
    );
  });

  test('kupcu praznične dekoracije sezona ostaje u punoj snazi', () => {
    const result = recommender.recommend({ userId: 'u6', now: DECEMBER });
    assert.equal(result.items[0]?.category, 'praznicna-dekoracija');

    const seasonal = result.items[0]!.reasons.find((r) => r.factor === 'godišnje doba');
    assert.ok(seasonal, 'očekivan sezonski razlog');
    assert.ok(Math.abs(seasonal!.contribution - 0.15) < 0.001, 'sezona je nepotrebno prigušena');
  });

  test('prigušenje je vidljivo u obrazloženju, ne skriveno', () => {
    const result = recommender.recommend({ userId: 'u1', now: DECEMBER });
    const holiday = result.items.find((i) => i.category === 'praznicna-dekoracija');
    const seasonal = holiday?.reasons.find((r) => r.factor === 'godišnje doba');
    assert.match(seasonal?.detail ?? '', /prigušena/);
  });

  test('korisnik bez istorije ne dobija prigušenje', () => {
    const result = recommender.recommend({ userId: 'niko', now: DECEMBER });
    const holiday = result.items.find((i) => i.category === 'praznicna-dekoracija');
    const seasonal = holiday?.reasons.find((r) => r.factor === 'godišnje doba');

    assert.ok(seasonal, 'očekivan sezonski razlog');
    assert.doesNotMatch(seasonal!.detail, /prigušena/);
  });
});

describe('preraspodela težina', () => {
  /**
   * Isto pravilo kao kod zaštite namere u pretrazi: kada faktor ne može da
   * doprinese, njegova težina se raspoređuje na ostale. Bez toga bi svaki
   * cold-start rezultat bio deo warm rezultata i dva se ne bi mogla porediti.
   */
  test('cold start preraspoređuje težinu faktora koji ne mogu da dejstvuju', () => {
    const cold = recommender.recommend({ userId: 'niko', now: DECEMBER });
    const warm = recommender.recommend({ userId: 'u1', now: DECEMBER });

    const seasonalOf = (r: typeof cold, category: string) =>
      r.items
        .find((i) => i.category === category)
        ?.reasons.find((x) => x.factor === 'godišnje doba')?.contribution ?? 0;

    const coldSeason = seasonalOf(cold, 'praznicna-dekoracija');
    const warmSeason = seasonalOf(warm, 'praznicna-dekoracija');

    assert.ok(coldSeason > 0.15, `očekivana preraspodeljena težina, dobijeno ${coldSeason}`);
    assert.ok(coldSeason > warmSeason, 'cold start mora jače da se osloni na sezonu');
  });

  test('cold i warm rezultati ostaju na istoj skali', () => {
    const cold = recommender.recommend({ userId: 'niko', now: DECEMBER });
    const warm = recommender.recommend({ userId: 'u1', now: DECEMBER });

    // Bez preraspodele bi cold rezultati bili višestruko manji samo zato
    // što kolaborativni faktor nema od čega da računa.
    assert.ok(cold.items[0]!.score > warm.items[0]!.score * 0.5);
  });

  test('cold start ne koristi faktore koji zavise od istorije', () => {
    const cold = recommender.recommend({ userId: 'niko', now: DECEMBER });
    const factors = new Set(cold.items.flatMap((i) => i.reasons.map((r) => r.factor)));
    assert.ok(!factors.has('zajedničko ponašanje'));
  });
});

describe('deklarisane težine faktora', () => {
  function withFactors(block: string) {
    const replaced = source.replace(
      /    factors \{[\s\S]*?\n    \}/,
      `    factors {\n${block}\n    }`,
    );
    return new Recommender(compile(parse(replaced, 'x.gs'), replaced, 'x.gs').plan, docs, events);
  }

  test('isključen faktor više ne doprinosi', () => {
    const noSeason = withFactors('      collaborative 0.45\n      popularity 0.10');
    const result = noSeason.recommend({ userId: 'u1', now: DECEMBER });
    const factors = new Set(result.items.flatMap((i) => i.reasons.map((r) => r.factor)));
    assert.ok(!factors.has('godišnje doba'));
  });

  test('povećana težina menja redosled', () => {
    const popularityHeavy = withFactors('      collaborative 0.05\n      popularity 0.95');
    const result = popularityHeavy.recommend({ userId: 'u1', now: JULY });
    // kr-001 je najgledaniji artikal u katalogu.
    assert.equal(result.items[0]?.id, 'kr-001');
  });

  test('explore 0 ukida istraživačke slotove', () => {
    const noExplore = source.replace('explore 0.25', 'explore 0');
    const engine = new Recommender(compile(parse(noExplore, 'x.gs'), noExplore, 'x.gs').plan, docs, events);
    assert.equal(engine.recommend({ userId: 'u1', now: JULY }).stats.exploration, 0);
  });

  test('GS2025: account for i factors zajedno su greška', () => {
    const both = source.replace('    factors {', '    account for [season]\n    factors {');
    try {
      compile(parse(both, 'x.gs'), both, 'x.gs');
      assert.fail('očekivana greška GS2025');
    } catch (err) {
      assert.ok(err instanceof GoSimpleError);
      assert.ok(err.diagnostics.some((d) => d.code === 'GS2025'));
    }
  });

  test('GS2027: težina van opsega 0–1 je greška', () => {
    const bad = source.replace('collaborative 0.45', 'collaborative 4.5');
    try {
      compile(parse(bad, 'x.gs'), bad, 'x.gs');
      assert.fail('očekivana greška GS2027');
    } catch (err) {
      assert.ok((err as GoSimpleError).diagnostics.some((d) => d.code === 'GS2027'));
    }
  });

  test('GS2021: nepoznat faktor nudi najbliže ime', () => {
    const typo = source.replace('collaborative 0.45', 'collaborativ 0.45');
    try {
      compile(parse(typo, 'x.gs'), typo, 'x.gs');
      assert.fail('očekivana greška GS2021');
    } catch (err) {
      const d = (err as GoSimpleError).diagnostics.find((x) => x.code === 'GS2021');
      assert.match(d?.hint ?? '', /collaborative/);
    }
  });

  test('GS2109: sve-iz-istorije konfiguracija upozorava na cold start', () => {
    const onlyHistory = source.replace(
      /    factors \{[\s\S]*?\n    \}/,
      '    factors {\n      collaborative 0.7\n      content 0.3\n    }',
    );
    const { warnings } = compile(parse(onlyHistory, 'x.gs'), onlyHistory, 'x.gs');
    assert.ok(warnings.some((w) => w.code === 'GS2109'));
  });
});

describe('istraživanje novih kategorija', () => {
  test('deo liste je rezervisan za kategorije van istorije korisnika', () => {
    const result = recommender.recommend({ userId: 'u1', now: JULY });
    assert.ok(result.stats.exploration > 0, 'nijedan slot nije dat novim kategorijama');

    const categories = new Set(result.items.map((i) => i.category));
    assert.ok(categories.size > 1, 'sve preporuke su iz iste kategorije');
  });
});

describe('objašnjenja', () => {
  test('svaka preporuka ima bar jedan razlog', () => {
    const result = recommender.recommend({ userId: 'u1', now: DECEMBER });
    for (const item of result.items) {
      assert.ok(item.reasons.length > 0, `"${item.title}" nema obrazloženje`);
    }
  });

  test('razlozi su sortirani po doprinosu', () => {
    const result = recommender.recommend({ userId: 'u1', now: DECEMBER });
    for (const item of result.items) {
      for (let i = 1; i < item.reasons.length; i++) {
        assert.ok(item.reasons[i - 1]!.contribution >= item.reasons[i]!.contribution);
      }
    }
  });

  test('cold start pošteno kaže da nema istoriju', () => {
    const result = recommender.recommend({ userId: 'niko', now: DECEMBER });
    const reasons = result.items.flatMap((i) => i.reasons.map((r) => r.detail));
    assert.ok(reasons.some((d) => /Nemamo istoriju/.test(d)));
  });
});

describe('learn from upravlja time šta se uči', () => {
  test('tipovi događaja van learn from se ignorišu', () => {
    const narrow = compile(
      parse(source.replace('learn from [views, clicks, add_to_cart, purchases]', 'learn from [purchases]'), 'x.gs'),
      source,
      'x.gs',
    ).plan;

    const onlyPurchases = new Recommender(narrow, docs, events);
    const result = onlyPurchases.recommend({ userId: 'u3', now: JULY });

    // u3 je kupio samo ad-004; pregledi se više ne računaju u istoriju.
    assert.equal(result.userHistorySize, 1);
  });

  test('odbijanje se poštuje i kada nije navedeno u learn from', () => {
    const narrow = compile(
      parse(source.replace('learn from [views, clicks, add_to_cart, purchases]', 'learn from [purchases]'), 'x.gs'),
      source,
      'x.gs',
    ).plan;

    const engine = new Recommender(narrow, docs, events);
    const result = engine.recommend({ userId: 'u5', now: JULY });
    assert.ok(!result.items.some((i) => i.id === 'br-003'), 'odbijen artikal je procurio');
  });
});

describe('dijagnostika recommend bloka', () => {
  test('GS2023: učenje iz događaja bez deklarisanog dnevnika je greška', () => {
    const broken = source.replace('events from "events.json"\n', '');
    try {
      compile(parse(broken, 'x.gs'), broken, 'x.gs');
      assert.fail('očekivana greška GS2023');
    } catch (err) {
      assert.ok(err instanceof GoSimpleError);
      assert.ok(err.diagnostics.some((d) => d.code === 'GS2023'));
    }
  });

  test('GS2107: recommend bez learn from daje upozorenje', () => {
    const weakened = source
      .replace('events from "events.json"\n', '')
      .replace('    learn from [views, clicks, add_to_cart, purchases]\n', '');
    const { warnings } = compile(parse(weakened, 'x.gs'), weakened, 'x.gs');
    assert.ok(warnings.some((w) => w.code === 'GS2107'));
  });
});
