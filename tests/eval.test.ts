import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluate,
  parseGoldenSet,
  scoreQuery,
  GoldenSetError,
  type GoldenQuery,
} from '../src/eval.ts';
import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { Engine, type Doc } from '../src/runtime/execute.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples');

function close(actual: number | null, expected: number, message: string): void {
  assert.ok(
    actual !== null && Math.abs(actual - expected) < 1e-4,
    `${message}: dobijeno ${actual}, očekivano ${expected}`,
  );
}

describe('učitavanje zlatnog skupa', () => {
  const load = (raw: unknown) => parseGoldenSet(raw, 'skup');

  test('odbija skup bez upita', () => {
    assert.throws(() => load({ queries: [] }), GoldenSetError);
  });

  test('odbija upit koji ništa ne tvrdi', () => {
    // Upit bez očekivanja ne može ni da prođe ni da padne, pa samo razblažuje
    // prosek i stvara utisak da je skup veći nego što jeste.
    assert.throws(
      () => load({ queries: [{ query: 'svećice' }] }),
      /ne tvrdi ništa/,
    );
  });

  test('odbija dokument koji je i relevantan i zabranjen', () => {
    assert.throws(
      () => load({ queries: [{ query: 'a', relevant: { 'x-1': 2 }, forbidden: ['x-1'] }] }),
      /istovremeno i relevantan i zabranjen/,
    );
  });

  test('odbija negativnu ocenu', () => {
    assert.throws(() => load({ queries: [{ query: 'a', relevant: { 'x-1': -1 } }] }), GoldenSetError);
  });

  test('odbija k koje nije ceo broj veći od nule', () => {
    assert.throws(() => load({ k: 0, queries: [{ query: 'a', relevant: { x: 1 } }] }), GoldenSetError);
    assert.throws(() => load({ k: 2.5, queries: [{ query: 'a', relevant: { x: 1 } }] }), GoldenSetError);
  });

  test('podrazumevano k je 10', () => {
    assert.equal(load({ queries: [{ query: 'a', relevant: { x: 1 } }] }).k, 10);
  });

  test('upit samo sa zabranama je ispravan', () => {
    // Tvrdnja „ovo ne sme da izađe" je sama po sebi potpun test.
    const set = load({ queries: [{ query: 'a', forbidden: ['x-1'] }] });
    assert.deepEqual(set.queries[0]!.forbidden, ['x-1']);
  });
});

describe('mere nad jednim upitom', () => {
  const golden: GoldenQuery = { query: 'svećice', relevant: { a: 3, b: 2 } };

  test('savršen poredak daje NDCG 1', () => {
    close(scoreQuery(golden, ['a', 'b'], 5).ndcg, 1, 'NDCG');
  });

  test('zamenjen poredak kažnjava, ali ne do nule', () => {
    // DCG = 3/log2(2) + 7/log2(3) = 7.4164; idealan = 8.8928.
    close(scoreQuery(golden, ['b', 'a'], 5).ndcg, 7.4164 / 8.8928, 'NDCG');
  });

  test('ocene su stepenovane, pa jedan tačan pogodak nadmašuje dva osrednja', () => {
    const odlican = scoreQuery({ query: 'q', relevant: { a: 3, b: 1, c: 1 } }, ['a'], 3).ndcg!;
    const osrednji = scoreQuery({ query: 'q', relevant: { a: 3, b: 1, c: 1 } }, ['b', 'c'], 3).ndcg!;
    assert.ok(odlican > osrednji, `${odlican} nije veće od ${osrednji}`);
  });

  test('k odseca listu', () => {
    const result = scoreQuery(golden, ['x', 'y', 'a'], 2);
    close(result.recall, 0, 'odziv');
    close(result.reciprocalRank, 0, 'RR');
  });

  test('recipročni rang prati prvi pogodak', () => {
    close(scoreQuery(golden, ['x', 'a'], 5).reciprocalRank, 0.5, 'RR');
    close(scoreQuery(golden, ['x', 'y', 'a'], 5).reciprocalRank, 1 / 3, 'RR');
  });

  test('preciznost se deli brojem prikazanih, ne sa k', () => {
    // Prodavnica sa tri rezultata ne sme da bude kažnjena zato što katalog
    // nije imao pet.
    close(scoreQuery(golden, ['a', 'x', 'y'], 10).precision, 1 / 3, 'preciznost');
  });

  test('upit bez ocenjenih dokumenata nema mere, ali ima zabrane', () => {
    const result = scoreQuery({ query: 'q', relevant: {}, forbidden: ['z'] }, ['z', 'a'], 5);
    assert.equal(result.ndcg, null);
    assert.equal(result.precision, null);
    assert.deepEqual(result.violations, ['z']);
  });

  test('zabrana izvan k se ne računa', () => {
    const result = scoreQuery({ query: 'q', relevant: { a: 1 }, forbidden: ['z'] }, ['a', 'z'], 1);
    assert.deepEqual(result.violations, []);
  });
});

describe('prosek preskače neodređene mere', () => {
  test('upit bez ocena ne vuče prosek nadole', async () => {
    const set = parseGoldenSet(
      {
        k: 3,
        queries: [
          { query: 'prvi', relevant: { a: 3 } },
          { query: 'drugi', forbidden: ['z'] },
        ],
      },
      'skup',
    );

    const report = await evaluate(set, async (golden) => ({
      hits: golden.query === 'prvi' ? [{ id: 'a' }] : [{ id: 'b' }],
    }) as never);

    close(report.ndcg, 1, 'ukupan NDCG');
    assert.equal(report.violations, 0);
  });
});

describe('zlatni skup iz primera', () => {
  const source = readFileSync(join(examples, 'prodavnica.gs'), 'utf8');
  const { plan } = compile(parse(source, 'prodavnica.gs'), source, 'prodavnica.gs');
  const docs = JSON.parse(readFileSync(join(examples, 'catalog.json'), 'utf8')) as Doc[];

  const bezZastiteSource = readFileSync(join(examples, 'prodavnica-bez-zastite.gs'), 'utf8');
  const bezZastite = compile(
    parse(bezZastiteSource, 'prodavnica-bez-zastite.gs'),
    bezZastiteSource,
    'prodavnica-bez-zastite.gs',
  ).plan;

  const set = parseGoldenSet(
    JSON.parse(readFileSync(join(examples, 'zlatni-skup.json'), 'utf8')),
    'examples/zlatni-skup.json',
  );

  async function run(p: typeof plan) {
    const engine = await Engine.create(p, docs);
    return evaluate(set, async (golden) => {
      const request: Parameters<Engine['search']>[0] = { query: golden.query };
      if (golden.now) request.now = golden.now;
      if (golden.season) request.season = golden.season;
      return engine.search(request);
    });
  }

  test('isporučeni plan ne krši nijednu zabranu', async () => {
    const report = await run(plan);
    assert.equal(
      report.violations,
      0,
      `plan pušta zabranjene dokumente: ${report.queries
        .filter((q) => q.violations.length > 0)
        .map((q) => `"${q.query}" → ${q.violations.join(', ')}`)
        .join('; ')}`,
    );
  });

  test('plan bez zaštite namere krši zabrane', async () => {
    const report = await run(bezZastite);
    assert.ok(report.violations > 0, 'uklanjanje `protect intent` nije ništa pokvarilo — skup ne meri ono zbog čega postoji');
  });

  test('prosek skoro ne primećuje štetu koju zaštita namere sprečava', async () => {
    // Ovo je cela teza projekta, iskazana brojkama. Da se kvalitet pretrage
    // ocenjivao samo prosečnim NDCG-om, uklanjanje `protect intent` prošlo
    // bi kao bezazlena izmena.
    const sa = await run(plan);
    const bez = await run(bezZastite);

    assert.ok(
      Math.abs(sa.ndcg! - bez.ndcg!) < 0.05,
      `razlika u proseku je ${Math.abs(sa.ndcg! - bez.ndcg!).toFixed(3)}, dovoljno velika da bi prosek bio dovoljan`,
    );
    assert.ok(bez.violations > sa.violations, 'broj prekršaja mora da pokaže ono što prosek ne pokazuje');
  });
});
