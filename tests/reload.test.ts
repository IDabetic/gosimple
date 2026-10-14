import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { Engine, type Doc } from '../src/runtime/execute.ts';
import { LocalEmbedding } from '../src/runtime/embed.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples');

const source = readFileSync(join(examples, 'prodavnica.gs'), 'utf8');
const { plan } = compile(parse(source, 'prodavnica.gs'), source, 'prodavnica.gs');
const original = JSON.parse(readFileSync(join(examples, 'catalog.json'), 'utf8')) as Doc[];

const clone = (docs: Doc[]): Doc[] => JSON.parse(JSON.stringify(docs)) as Doc[];

const QUERIES = ['svećice', 'svećice za Subaru', 'svećice za baštu', 'sijalica', 'bobina'];
const NOW = '2026-12-15T10:00:00Z';

function withoutTiming(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === 'durationMs' ? 0 : v)));
}

/**
 * Jedina tvrdnja koja ovde znači nešto: engine koji je dopunjen mora da
 * odgovara isto kao engine podignut iz nule nad istim katalogom. Sve ispod
 * toga je optimizacija koja tiho menja rezultate.
 */
async function assertMatchesFreshBuild(
  reloaded: Engine,
  docs: Doc[],
  label: string,
  embedding = false,
): Promise<void> {
  const fresh = await Engine.create(plan, clone(docs), embedding ? { embedding: new LocalEmbedding() } : {});

  for (const query of QUERIES) {
    assert.deepEqual(
      withoutTiming(await reloaded.search({ query, now: NOW })),
      withoutTiming(await fresh.search({ query, now: NOW })),
      `${label}: upit "${query}" se razlikuje od sveže izgrađenog engine-a`,
    );
  }
}

describe('reload kataloga bez restarta', () => {
  test('isti katalog ništa ne menja', async () => {
    const engine = await Engine.create(plan, clone(original));
    const change = await engine.reload(clone(original));

    assert.deepEqual(change, { added: 0, updated: 0, removed: 0 });
    await assertMatchesFreshBuild(engine, original, 'nepromenjen katalog');
  });

  test('izmena cene i pregleda', async () => {
    const engine = await Engine.create(plan, clone(original));
    const docs = clone(original);
    docs[0]!.price = 4999;
    docs[0]!.views = 999_999;

    const change = await engine.reload(docs);
    assert.deepEqual(change, { added: 0, updated: 1, removed: 0 });
    await assertMatchesFreshBuild(engine, docs, 'izmenjena cena');
  });

  test('brisanje najgledanijeg proizvoda preskalira popularnost svima', async () => {
    // Maksimum pregleda je imenilac za popularnost, pa njegov odlazak menja
    // skor dokumentima koje niko nije dirao.
    const engine = await Engine.create(plan, clone(original));
    const docs = clone(original);
    const najgledaniji = docs.reduce((a, b) => ((a.views ?? 0) >= (b.views ?? 0) ? a : b));
    const preostali = docs.filter((d) => d.id !== najgledaniji.id);

    const change = await engine.reload(preostali);
    assert.deepEqual(change, { added: 0, updated: 0, removed: 1 });
    await assertMatchesFreshBuild(engine, preostali, 'obrisan najgledaniji');
  });

  test('dodavanje prepisanog opisa obara originalnost postojećem proizvodu', async () => {
    // Duplikacija je mera u odnosu na katalog. Novi proizvod koji prepiše
    // tuđi opis kvari ocenu i tom drugom, iako on nije ni taknut.
    const engine = await Engine.create(plan, clone(original));
    const zrtva = original.find((d) => (d.description ?? '').length > 60)!;
    const pre = engine.contentFor(zrtva.id)!.originality;

    const docs = clone(original);
    docs.push({ ...zrtva, id: 'prepisano-1', title: 'Prepisani proizvod' });

    await engine.reload(docs);

    const posle = engine.contentFor(zrtva.id)!.originality;
    assert.ok(posle < pre, `originalnost je ostala ${posle}, a trebalo je da padne sa ${pre}`);
    await assertMatchesFreshBuild(engine, docs, 'dodata kopija');
  });

  test('brisanje kopije vraća originalnost', async () => {
    const docs = clone(original);
    const zrtva = docs.find((d) => (d.description ?? '').length > 60)!;
    docs.push({ ...zrtva, id: 'prepisano-1', title: 'Prepisani proizvod' });

    const engine = await Engine.create(plan, clone(docs));
    const saKopijom = engine.contentFor(zrtva.id)!.originality;

    await engine.reload(clone(original));

    const bezKopije = engine.contentFor(zrtva.id)!.originality;
    assert.ok(bezKopije > saKopijom, `originalnost je ostala ${bezKopije} iako je kopija obrisana`);
    await assertMatchesFreshBuild(engine, original, 'obrisana kopija');
  });

  test('istovremeno dodavanje, izmena i brisanje', async () => {
    const engine = await Engine.create(plan, clone(original));

    const docs = clone(original).filter((d) => d.id !== 'br-002');
    docs[1]!.title = 'Potpuno nov naslov sa drugim rečima o paljenju motora';
    docs.push({
      id: 'nv-001',
      title: 'Zimske gume 205/55 R16 sa felnama',
      description: 'Komplet od četiri zimske gume sa čeličnim felnama i senzorima pritiska.',
      category: 'auto-delovi',
      price: 32000,
      views: 410,
      purchases: 18,
      available: true,
    });

    const change = await engine.reload(docs);
    assert.deepEqual(change, { added: 1, updated: 1, removed: 1 });
    await assertMatchesFreshBuild(engine, docs, 'mešovita izmena');
  });

  test('prazan katalog', async () => {
    const engine = await Engine.create(plan, clone(original));
    const change = await engine.reload([]);

    assert.equal(change.removed, original.length);
    const response = await engine.search({ query: 'svećice', now: NOW });
    assert.equal(response.hits.length, 0);
    assert.equal(response.stats.corpusSize, 0);
  });

  test('katalog izgrađen reload-ovima jednak je katalogu učitanom odjednom', async () => {
    // Redosled stizanja ne sme da se vidi u rezultatima.
    const engine = await Engine.create(plan, []);
    for (const doc of original) {
      await engine.reload(clone(original.slice(0, original.indexOf(doc) + 1)));
    }
    await assertMatchesFreshBuild(engine, original, 'izgrađen postepeno');
  });

  test('dva dokumenta sa istim id su greška, ne tiho gaženje', async () => {
    const engine = await Engine.create(plan, clone(original));
    const docs = clone(original);
    docs.push({ ...docs[0]!, title: 'Drugi proizvod sa istim id' });

    await assert.rejects(() => engine.reload(docs), /istim id/);
  });

  test('vektori se dopunjuju za nove dokumente', async () => {
    const engine = await Engine.create(plan, clone(original), { embedding: new LocalEmbedding() });

    const docs = clone(original);
    docs.push({
      id: 'nv-002',
      title: 'Grejač zadnjeg stakla univerzalni',
      description: 'Samolepljiva traka grejača za zadnje staklo, dvanaest volti.',
      category: 'auto-delovi',
      views: 12,
      available: true,
    });

    await engine.reload(docs);
    await assertMatchesFreshBuild(engine, docs, 'novi dokument sa vektorom', true);
  });
});
