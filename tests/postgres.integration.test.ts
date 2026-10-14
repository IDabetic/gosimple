import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { createSource, SourceError } from '../src/sources/index.ts';
import { Engine, type Doc } from '../src/runtime/execute.ts';
import type { IRSource } from '../src/ir.ts';

/**
 * Integration tests against a real PostgreSQL server.
 *
 * Everything else in the suite runs with no external services. These do not,
 * because the questions they answer cannot be answered any other way: does
 * `numeric` arrive as a number, does `text[]` arrive as an array, and — the
 * reason this file exists — can a crafted `where` clause actually read a
 * table it was never given.
 *
 * Set GOSIMPLE_TEST_PG to a connection string to run them. CI starts a
 * service container; locally:
 *
 *   initdb -D /tmp/gs-pg -U gstest --auth=trust
 *   pg_ctl -D /tmp/gs-pg -o "-p 55432 -k /tmp" start
 *   createdb -h 127.0.0.1 -p 55432 -U gstest shop
 *   GOSIMPLE_TEST_PG=postgres://gstest@127.0.0.1:55432/shop npm test
 *
 * Skipping is deliberate rather than silent: a developer without a database
 * still gets a green suite, and CI still gets the coverage.
 */
const CONNECTION = process.env.GOSIMPLE_TEST_PG;
const skip = CONNECTION ? false : 'GOSIMPLE_TEST_PG nije postavljen';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(here, '..', 'examples', 'catalog.json'), 'utf8'),
) as Doc[];

const COLUMNS = {
  id: 'product_id',
  title: 'name',
  description: 'descr',
  category: 'category_slug',
  brand: 'brand_name',
  price: 'price_rsd',
  available: 'in_stock',
  views: 'view_count',
  purchases: 'order_count',
  createdAt: 'created',
  tags: 'label_list',
};

function sourceFor(overrides: Partial<IRSource> = {}) {
  return createSource(
    {
      name: 'products',
      uri: CONNECTION ?? "",
      table: 'products',
      columns: COLUMNS,
      where: 'deleted_at IS NULL',
      limit: 50_000,
      ...overrides,
    },
    here,
  );
}

async function sql(statements: string): Promise<void> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { Pool: new (o: object) => { query: (s: string) => Promise<unknown>; end: () => Promise<void> } };
  const pool = new pg.Pool({ connectionString: CONNECTION });
  try {
    await pool.query(statements);
  } finally {
    await pool.end();
  }
}

describe('PostgreSQL protiv žive baze', { skip }, () => {
  before(async () => {
    await sql(`
      DROP TABLE IF EXISTS products;
      DROP TABLE IF EXISTS users;

      CREATE TABLE products (
        product_id    text PRIMARY KEY,
        name          text NOT NULL,
        descr         text,
        category_slug text NOT NULL,
        brand_name    text,
        price_rsd     numeric(10,2),
        in_stock      boolean DEFAULT true,
        view_count    integer DEFAULT 0,
        order_count   integer DEFAULT 0,
        created       timestamptz,
        label_list    text[],
        deleted_at    timestamptz
      );

      -- Tabela koja nikada ne sme da procuri kroz where uslov.
      CREATE TABLE users (username text, password_hash text);
      INSERT INTO users VALUES ('admin', 'TAJNI_HES_1'), ('ivan', 'TAJNI_HES_2');
    `);

    const literal = (value: unknown): string =>
      value === null || value === undefined
        ? 'NULL'
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : `'${String(value).replace(/'/g, "''")}'`;

    const rows = catalog.map(
      (d) =>
        `(${[
          literal(d.id),
          literal(d.title),
          literal(d.description),
          literal(d.category),
          literal(d.brand),
          d.price ?? 'NULL',
          d.available ?? 'NULL',
          d.views ?? 'NULL',
          d.purchases ?? 'NULL',
          literal(d.createdAt),
          d.tags ? `ARRAY[${d.tags.map(literal).join(',')}]::text[]` : 'NULL',
        ].join(',')})`,
    );

    await sql(`
      INSERT INTO products
        (product_id,name,descr,category_slug,brand_name,price_rsd,in_stock,view_count,order_count,created,label_list)
      VALUES ${rows.join(',')};

      INSERT INTO products (product_id, name, category_slug, deleted_at)
      VALUES ('obrisan-1', 'Obrisani proizvod', 'auto-delovi', now());
    `);
  });

  after(async () => {
    await sql('DROP TABLE IF EXISTS products; DROP TABLE IF EXISTS users;');
  });

  describe('učitavanje', () => {
    test('mapirane kolone postaju GoSimple polja', async () => {
      const adapter = sourceFor();
      const docs = await adapter.load();
      await adapter.close();

      const doc = docs.find((d) => d.id === 'ad-001');
      assert.ok(doc, 'ad-001 nije učitan');
      assert.equal(doc!.title, 'NGK svećice BKR6E-11 komplet 4 kom');
      assert.equal(doc!.category, 'auto-delovi');
      assert.equal(doc!.brand, 'NGK');
    });

    test('numeric stiže kao broj, ne kao string', async () => {
      // pg podrazumevano vraća numeric kao string da ne bi izgubio preciznost;
      // bez konverzije bi se cene tiho sabirale kao tekst.
      const adapter = sourceFor();
      const docs = await adapter.load();
      await adapter.close();

      const doc = docs.find((d) => d.id === 'ad-001')!;
      assert.equal(typeof doc.price, 'number');
      assert.equal(doc.price, 2400);
    });

    test('timestamptz stiže kao ISO tekst, boolean kao boolean, text[] kao niz', async () => {
      const adapter = sourceFor();
      const docs = await adapter.load();
      await adapter.close();

      const doc = docs.find((d) => d.id === 'ad-001')!;
      assert.equal(typeof doc.createdAt, 'string');
      assert.ok(!Number.isNaN(Date.parse(doc.createdAt!)));
      assert.equal(typeof doc.available, 'boolean');
      assert.ok(Array.isArray(doc.tags));
      assert.ok(doc.tags!.includes('subaru'));
    });

    test('where uslov zaista odseca redove u bazi', async () => {
      const adapter = sourceFor();
      const docs = await adapter.load();
      await adapter.close();

      assert.equal(docs.length, catalog.length, 'obrisani red je prošao');
      assert.ok(!docs.some((d) => d.id === 'obrisan-1'));
    });

    test('limit se primenjuje u bazi, ne posle učitavanja', async () => {
      const adapter = sourceFor({ limit: 3 });
      const docs = await adapter.load();
      await adapter.close();
      assert.equal(docs.length, 3);
    });

    test('parametrizovan where filtrira po vrednosti', async () => {
      const adapter = sourceFor({ where: "category_slug = 'auto-delovi' AND deleted_at IS NULL" });
      const docs = await adapter.load();
      await adapter.close();

      assert.ok(docs.length > 0);
      assert.ok(docs.every((d) => d.category === 'auto-delovi'));
    });
  });

  describe('SQL injekcija', () => {
    /**
     * Ovaj napad je RADIO protiv ove iste baze dok je where uslov prolazio
     * kroz blok-listu ";", "--" i "/*". Izvukao je hešove lozinki iz tabele
     * users. Ne sadrži nijedan zabranjen znak — zato blok-liste i ne rade.
     */
    test('UNION ka tuđoj tabeli ne izvlači ništa', async () => {
      const adapter = sourceFor({
        where: 'false UNION SELECT username, password_hash, category_slug FROM users',
      });

      await assert.rejects(
        async () => {
          const docs = await adapter.load();
          throw new Error(
            `where uslov je prošao i vratio ${docs.length} redova: ${docs.map((d) => d.title).join(', ')}`,
          );
        },
        SourceError,
        'UNION injekcija nije odbijena',
      );

      await adapter.close();
    });

    test('hešovi lozinki ostaju u svojoj tabeli', async () => {
      // Dokazuje da podaci postoje i da su dohvatljivi legitimnim putem,
      // pa test iznad ne prolazi slučajno zbog prazne tabele.
      const adapter = sourceFor();
      const docs = await adapter.load();
      await adapter.close();

      const leaked = docs.filter((d) => String(d.title).startsWith('TAJNI_HES'));
      assert.deepEqual(leaked, [], 'hešovi lozinki su procureli u rezultate');
    });

    test('podupit u IN listi se odbija pre nego što baza išta vidi', async () => {
      const adapter = sourceFor({ where: 'product_id IN (SELECT username FROM users)' });
      await assert.rejects(() => adapter.load(), SourceError);
      await adapter.close();
    });

    test('pokušaj menjanja podataka se odbija', async () => {
      const adapter = sourceFor({ where: 'deleted_at IS NULL; DELETE FROM products' });
      await assert.rejects(() => adapter.load(), SourceError);
      await adapter.close();

      // I dalje je sve na mestu.
      const check = sourceFor();
      const docs = await check.load();
      await check.close();
      assert.equal(docs.length, catalog.length);
    });
  });

  describe('ceo motor nad bazom', () => {
    test('zaštita namere radi isto kao nad JSON izvorom', async () => {
      // Primer čita kredencijale iz okruženja; test ih prosleđuje isto
      // tako, umesto da prepisuje fajl.
      process.env.GOSIMPLE_PG = CONNECTION!.replace(/^postgres(ql)?:\/\//, '');
      const program = readFileSync(join(here, '..', 'examples', 'prodavnica-pg.gs'), 'utf8');
      const { plan } = compile(parse(program, 'pg.gs'), program, 'pg.gs');

      const adapter = createSource(plan.source, here);
      const docs = await adapter.load();
      const engine = await Engine.create(plan, docs);

      const result = await engine.search({
        query: 'svećice za Subaru',
        now: '2026-12-15T10:00:00Z',
      });
      await adapter.close();

      assert.equal(result.season, 'zima');
      assert.equal(result.intent.locked, true);
      assert.equal(result.intent.category, 'auto-delovi');
      assert.deepEqual(
        result.hits.filter((h) => h.category === 'praznicna-dekoracija'),
        [],
        'sezona je prevagnula nad zaključanom namerom nad bazom',
      );
    });

    test('rezultati iz baze su identični rezultatima iz JSON-a', async () => {
      // Izvor podataka ne sme da menja rangiranje. Ako menja, konverzija
      // tipova negde gubi informaciju.
      const jsonProgram = readFileSync(join(here, '..', 'examples', 'prodavnica.gs'), 'utf8');
      const jsonPlan = compile(parse(jsonProgram, 'j.gs'), jsonProgram, 'j.gs').plan;
      const jsonEngine = await Engine.create(jsonPlan, catalog);

      const adapter = sourceFor();
      const pgDocs = await adapter.load();
      await adapter.close();
      const pgEngine = await Engine.create(jsonPlan, pgDocs);

      const query = { query: 'svećice za Subaru', now: '2026-12-15T10:00:00Z' };
      const fromJson = await jsonEngine.search(query);
      const fromPg = await pgEngine.search(query);

      assert.deepEqual(
        fromPg.hits.map((h) => [h.id, Number(h.score.toFixed(6))]),
        fromJson.hits.map((h) => [h.id, Number(h.score.toFixed(6))]),
      );
    });
  });
});
