import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { GoSimpleError } from '../src/diagnostics.ts';
import { createSource, expandEnv, mapRow, PostgresSource, SourceError } from '../src/sources/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples');

const PG_PROGRAM = `
source products from "postgres://user:secret@db.local:5432/shop" {
  table "products"
  map {
    id          "product_id"
    title       "name"
    description "long_description"
    category    "category_slug"
    price       "price_rsd"
    available   "in_stock"
    views       "view_count"
    createdAt   "created_at"
    tags        "tag_list"
  }
  where "deleted_at IS NULL"
  limit 5000
}

taxonomy { category "a" { terms ["x"] signals ["sa"] } }

engine E {
  search {
    retrieve 100 candidates
    match { keywords weight 1.0 }
    rank by { query_relevance 1.0 }
    return top 10
  }
}
`;

function compileSource(source: string) {
  return compile(parse(source, 't.gs'), source, 't.gs');
}

function expectError(source: string, code: string) {
  try {
    compileSource(source);
    assert.fail(`Očekivana greška ${code}, ali kompilacija je uspela`);
  } catch (err) {
    assert.ok(err instanceof GoSimpleError);
    const codes = err.diagnostics.map((d) => d.code);
    assert.ok(codes.includes(code), `Očekivan ${code}, dobijeni: ${codes.join(', ')}`);
  }
}

describe('deklaracija izvora', () => {
  test('PostgreSQL izvor se kompajlira sa mapiranjem kolona', () => {
    const { plan } = compileSource(PG_PROGRAM);
    assert.equal(plan.source.table, 'products');
    assert.equal(plan.source.columns['id'], 'product_id');
    assert.equal(plan.source.where, 'deleted_at IS NULL');
    assert.equal(plan.source.limit, 5000);
  });

  test('GS2041: SQL izvor bez tabele je greška', () => {
    expectError(PG_PROGRAM.replace('  table "products"\n', ''), 'GS2041');
  });

  test('GS2044: SQL izvor mora da mapira id, title i category', () => {
    expectError(PG_PROGRAM.replace('    category    "category_slug"\n', ''), 'GS2044');
  });

  test('GS2040: nepoznato polje dokumenta u map bloku', () => {
    expectError(PG_PROGRAM.replace('price       "price_rsd"', 'prica       "price_rsd"'), 'GS2040');
  });

  test('GS2043: naziv kolone koji nije ispravan identifikator se odbija', () => {
    expectError(PG_PROGRAM.replace('"product_id"', '"id; DROP TABLE products"'), 'GS2043');
  });

  test('GS2042: where sa separatorom naredbi se odbija', () => {
    expectError(PG_PROGRAM.replace('"deleted_at IS NULL"', '"1=1; DELETE FROM products"'), 'GS2042');
  });

  test('GS2042: where sa SQL komentarom se odbija', () => {
    expectError(PG_PROGRAM.replace('"deleted_at IS NULL"', '"1=1 -- "'), 'GS2042');
  });

  test('GS2106: table i map na JSON izvoru daju upozorenje', () => {
    const source = PG_PROGRAM.replace(
      'postgres://user:secret@db.local:5432/shop',
      'catalog.json',
    ).replace('  where "deleted_at IS NULL"\n', '');
    const { warnings } = compileSource(source);
    assert.ok(warnings.some((w) => w.code === 'GS2106'));
  });
});

describe('generisanje SQL-a', () => {
  test('SELECT sadrži samo mapirane kolone, sve pod navodnicima', () => {
    const { plan } = compileSource(PG_PROGRAM);
    const { text } = new PostgresSource(plan.source).buildQuery();

    assert.match(text, /^SELECT /);
    assert.match(text, /"product_id"/);
    assert.match(text, /FROM "products"/);
    assert.match(text, /WHERE "deleted_at" IS NULL/);
    assert.match(text, /LIMIT 5000$/);
  });

  test('upit je uvek ograničen i kada limit nije naveden', () => {
    const { plan } = compileSource(PG_PROGRAM.replace('  limit 5000\n', ''));
    const { text } = new PostgresSource(plan.source).buildQuery();
    assert.match(text, /LIMIT \d+$/);
  });

  test('literali iz where uslova odlaze kao parametri, ne kao tekst upita', () => {
    const { plan } = compileSource(
      PG_PROGRAM.replace('where "deleted_at IS NULL"', `where "in_stock = TRUE AND price_rsd < 5000"`),
    );
    const { text, values } = new PostgresSource(plan.source).buildQuery();

    assert.match(text, /"in_stock" = \$1 AND "price_rsd" < \$2/);
    assert.deepEqual(values, [true, 5000]);
    // Ako vrednost ikada završi u tekstu upita, parametrizacija je probijena.
    assert.ok(!text.includes('5000') || text.endsWith('LIMIT 5000'));
  });

  test('runtime odbija nedozvoljen identifikator i kada plan zaobiđe kompajler', () => {
    // Ručno sklopljen plan simulira zaobilaženje kompajlera.
    const source = new PostgresSource({
      name: 'p',
      uri: 'postgres://localhost/db',
      table: 'products"; DROP TABLE users; --',
      columns: { id: 'id', title: 'name', category: 'cat' },
      where: null,
      limit: null,
    });
    assert.throws(() => source.buildQuery(), SourceError);
  });

  test('describe ne otkriva lozinku iz konekcionog stringa', () => {
    const { plan } = compileSource(PG_PROGRAM);
    const described = new PostgresSource(plan.source).describe();
    assert.doesNotMatch(described, /secret/);
    assert.match(described, /db\.local/);
  });
});

describe('mapiranje redova', () => {
  const columns = {
    id: 'product_id',
    title: 'name',
    category: 'category_slug',
    price: 'price_rsd',
    available: 'in_stock',
    views: 'view_count',
    createdAt: 'created_at',
    tags: 'tag_list',
  };

  test('tipovi se svode na ono što engine očekuje', () => {
    const doc = mapRow(
      {
        product_id: 42,
        name: 'Svećice',
        category_slug: 'auto-delovi',
        price_rsd: '2400.50',
        in_stock: 't',
        view_count: '180',
        created_at: new Date('2026-01-01T00:00:00Z'),
        tag_list: '{svecice,auto}',
      },
      columns,
    );

    assert.ok(doc);
    assert.equal(doc!.id, '42');
    assert.equal(doc!.price, 2400.5);
    assert.equal(doc!.available, true);
    assert.equal(doc!.views, 180);
    assert.equal(doc!.createdAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(doc!.tags, ['svecice', 'auto']);
  });

  test('boolean varijante se tumače ispravno', () => {
    for (const [raw, expected] of [['f', false], ['false', false], [0, false], ['t', true], [1, true], [true, true]] as const) {
      const doc = mapRow({ product_id: '1', name: 'x', category_slug: 'c', in_stock: raw }, columns);
      assert.equal(doc!.available, expected, `pogrešno za ulaz ${JSON.stringify(raw)}`);
    }
  });

  test('red bez obaveznog polja se odbacuje umesto da proizvede pokvaren dokument', () => {
    assert.equal(mapRow({ name: 'bez id-ja', category_slug: 'c' }, columns), null);
    assert.equal(mapRow({ product_id: '1', category_slug: 'c' }, columns), null);
    assert.equal(mapRow({ product_id: '1', name: 'x' }, columns), null);
  });

  test('null vrednosti ne postaju string "null"', () => {
    const doc = mapRow(
      { product_id: '1', name: 'x', category_slug: 'c', price_rsd: null, view_count: null },
      columns,
    );
    assert.equal(doc!.price, undefined);
    assert.equal(doc!.views, undefined);
  });
});

describe('kredencijali iz okruženja', () => {
  /**
   * Konekcioni string zapisan u .gs fajlu odlazi u git zajedno sa lozinkom,
   * gde preživi svaku rotaciju i pojavi se u svakom kloniranju.
   */
  test('${VAR} se zamenjuje vrednošću iz okruženja', () => {
    assert.equal(
      expandEnv('postgres://${DB}/shop', { DB: 'korisnik:tajna@host:5432' }),
      'postgres://korisnik:tajna@host:5432/shop',
    );
  });

  test('više promenljivih u istom stringu', () => {
    assert.equal(
      expandEnv('postgres://${U}:${P}@${H}/shop', { U: 'a', P: 'b', H: 'c' }),
      'postgres://a:b@c/shop',
    );
  });

  test('nepostavljena promenljiva se prijavlja imenom, ne tiho prazni', () => {
    // Tiha zamena praznim stringom bi dala konekcioni string koji se spaja
    // na pogrešno mesto, što je gore od jasne greške pri pokretanju.
    assert.throws(() => expandEnv('postgres://${NEMA_ME}/shop', {}), /NEMA_ME/);
  });

  test('prazna promenljiva se tretira kao nepostavljena', () => {
    assert.throws(() => expandEnv('postgres://${PRAZNA}/shop', { PRAZNA: '' }), /PRAZNA/);
  });

  test('sve nepostavljene se prijavljuju odjednom', () => {
    // Jedna po jedna bi značila onoliko neuspelih pokretanja koliko ima
    // promenljivih.
    assert.throws(() => expandEnv('${A}${B}', {}), /"A", "B"/);
  });

  test('string bez ${} prolazi nepromenjen', () => {
    assert.equal(expandEnv('catalog.json', {}), 'catalog.json');
  });

  test('IR plan zadržava ${VAR}, pa se može deliti bez kredencijala', () => {
    const { plan } = compileSource(PG_PROGRAM.replace(/postgres:\/\/[^"]+/, 'postgres://${TAJNA}/shop'));
    assert.match(plan.source.uri, /\$\{TAJNA\}/);
    assert.ok(!JSON.stringify(plan).includes('lozinka'));
  });

  test('GS2111: lozinka zapisana u fajlu daje upozorenje', () => {
    const { warnings } = compileSource(
      PG_PROGRAM.replace(/postgres:\/\/[^"]+/, 'postgres://admin:TajnaLozinka@db.internal/shop'),
    );
    const found = warnings.find((w) => w.code === 'GS2111');
    assert.ok(found, 'lozinka u konekcionom stringu je prošla bez upozorenja');
    assert.match(found!.hint ?? '', /PROMENLJIVA/);
  });

  test('${VAR} na mestu lozinke ne pokreće GS2111', () => {
    const { warnings } = compileSource(
      PG_PROGRAM.replace(/postgres:\/\/[^"]+/, 'postgres://admin:${DB_PASS}@db.internal/shop'),
    );
    assert.ok(!warnings.some((w) => w.code === 'GS2111'));
  });
});

describe('describe() ne odaje više nego što treba', () => {
  /**
   * `describe()` se prikazuje na /health, pa sve što vrati treba smatrati
   * javnim u okviru mreže u kojoj runtime radi.
   */
  test('JSON izvor prikazuje samo ime fajla, ne putanju', () => {
    const adapter = createSource(
      { name: 'p', uri: 'catalog.json', table: null, columns: {}, where: null, limit: null },
      join(here, '..', 'examples'),
    );

    const described = adapter.describe();
    assert.equal(described, 'json:catalog.json');
    assert.ok(!described.includes('/'), `putanja procurila: ${described}`);
  });

  test('PostgreSQL izvor ne prikazuje kredencijale', () => {
    const adapter = createSource(
      {
        name: 'p',
        uri: 'postgres://korisnik:lozinka123@db.internal:5432/shop',
        table: 'products',
        columns: { id: 'id', title: 'name', category: 'cat' },
        where: null,
        limit: null,
      },
      here,
    );

    const described = adapter.describe();
    assert.ok(!described.includes('lozinka123'), `lozinka procurila: ${described}`);
    assert.ok(!described.includes('korisnik'), `korisničko ime procurilo: ${described}`);
    assert.match(described, /db\.internal/);
  });
});

describe('izbor adaptera', () => {
  test('JSON putanja se razrešava u odnosu na direktorijum programa', async () => {
    const adapter = createSource(
      { name: 'p', uri: 'catalog.json', table: null, columns: {}, where: null, limit: null },
      examples,
    );
    const docs = await adapter.load();
    assert.ok(docs.length > 0);
    assert.match(adapter.describe(), /catalog\.json$/);
  });

  test('nepodržana šema daje jasnu poruku', () => {
    assert.throws(
      () =>
        createSource(
          { name: 'p', uri: 'mysql://localhost/db', table: null, columns: {}, where: null, limit: null },
          examples,
        ),
      /Nepodr/,
    );
  });

  test('nepostojeći JSON fajl daje poruku sa putanjom', async () => {
    const adapter = createSource(
      { name: 'p', uri: 'nema-me.json', table: null, columns: {}, where: null, limit: null },
      examples,
    );
    await assert.rejects(() => adapter.load(), SourceError);
  });
});
