import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { Engine, type Doc } from '../src/runtime/execute.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const examples = join(root, 'examples');

const source = readFileSync(join(examples, 'prodavnica.gs'), 'utf8');
const { plan } = compile(parse(source, 'prodavnica.gs'), source, 'prodavnica.gs');

/** Timing is the one field allowed to differ between two identical runs. */
function withoutTiming(response: unknown): unknown {
  return JSON.parse(
    JSON.stringify(response, (key, value) => (key === 'durationMs' ? 0 : value)),
  );
}

const QUERIES = [
  'svećice',
  'svećice za Subaru',
  'svećice za baštu',
  'LED lampice',
  'bušilica',
  'frižider sa dve komore',
  'kočione pločice',
  'nepostojeći proizvod xyzzy',
  '',
  'za i u na', // samo stopwords — ne ostaje nijedan token
  'ŠVEĆICE ЋИРИЛИЦА',
];

const MOMENTS = ['2026-12-15T10:00:00Z', '2026-07-15T10:00:00Z'];

describe('invertovani indeks daje iste rezultate kao pun prolaz', () => {
  /**
   * Indeks sme da bude brži, ali ne sme da bude drugačiji. Ako ova tvrdnja
   * padne, optimizacija je tiho promenila rangiranje, a to je gore nego da
   * je spora: niko ne bi primetio dok neko ne ostane bez prodaje.
   */
  async function assertSame(docs: Doc[], label: string): Promise<void> {
    const indexed = await Engine.create(plan, docs);
    const scanned = await Engine.create(plan, docs, { scanAllDocuments: true });

    for (const query of QUERIES) {
      for (const now of MOMENTS) {
        const a = withoutTiming(await indexed.search({ query, now }));
        const b = withoutTiming(await scanned.search({ query, now }));
        assert.deepEqual(a, b, `${label}: upit "${query}" u ${now} se razlikuje`);
      }
    }
  }

  test('nad katalogom iz primera', async () => {
    const docs = JSON.parse(readFileSync(join(examples, 'catalog.json'), 'utf8')) as Doc[];
    await assertSame(docs, 'examples/catalog.json');
  });

  test('nad sintetičkim katalogom od 2000 proizvoda', async () => {
    const docs = JSON.parse(
      execFileSync(process.execPath, [join(root, 'scripts', 'generate-catalog.mjs'), '2000'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 128,
      }),
    ) as Doc[];
    await assertSame(docs, 'sintetički katalog');
  });

  test('nad praznim katalogom', async () => {
    await assertSame([], 'prazan katalog');
  });
});

describe('indeks ne menja statistiku pretrage', () => {
  test('broj pregledanih dokumenata je i dalje veličina kataloga', async () => {
    // `corpusSize` opisuje katalog, ne ono što je indeks slučajno dodirnuo.
    // Da indeks procuri u ovaj broj, objašnjenja rezultata bi počela da
    // zavise od toga kako je pretraga izvedena umesto šta je pronašla.
    const docs = JSON.parse(readFileSync(join(examples, 'catalog.json'), 'utf8')) as Doc[];
    const engine = await Engine.create(plan, docs);
    const response = await engine.search({ query: 'svećice' });
    assert.equal(response.stats.corpusSize, docs.length);
  });
});
