import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { columnsOf, parseWhere, toSql, WhereParseError } from '../src/sources/where.ts';

/** Parses and renders, returning the SQL fragment and its bound parameters. */
function render(input: string): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  return { sql: toSql(parseWhere(input), params), params };
}

function rejects(input: string): WhereParseError {
  try {
    parseWhere(input);
  } catch (err) {
    assert.ok(err instanceof WhereParseError, `očekivana WhereParseError, dobijeno ${err}`);
    return err as WhereParseError;
  }
  throw new assert.AssertionError({ message: `where uslov je prošao iako ne bi smeo: ${input}` });
}

describe('SQL injekcija kroz where uslov', () => {
  /**
   * Ovi testovi postoje zato što je raniji pristup — odbacivanje ";", "--"
   * i "/*" — propustio tačno prvi napad koji ih ne koristi. Napad je
   * reprodukovan protiv žive baze i izvukao hešove lozinki iz druge tabele.
   *
   * Svaki unos ispod je prolazio kroz staru blok-listu.
   */
  test('UNION ka drugoj tabeli se odbija', () => {
    const err = rejects('false UNION SELECT username, password_hash, category_slug FROM users');
    assert.match(err.message, /UNION/);
    assert.match(err.hint ?? '', /Podupiti/);
  });

  test('UNION nakalemljen na ispravan uslov se odbija', () => {
    rejects('deleted_at IS NULL UNION SELECT username, password_hash, username FROM users');
  });

  test('podupit kao vrednost se odbija', () => {
    rejects('product_id IN (SELECT username FROM users)');
  });

  test('podupit kao izraz se odbija', () => {
    rejects('(SELECT count(*) FROM users) > 0');
  });

  test('poziv funkcije se odbija imenom, ne opštom porukom', () => {
    const err = rejects('pg_sleep(10) IS NOT NULL');
    assert.match(err.message, /Pozivi funkcija/);
    assert.match(err.message, /pg_sleep/);
  });

  test('poređenje dve kolone se odbija', () => {
    // Inače bi se podaci mogli iscediti upoređivanjem kolona međusobno.
    const err = rejects('name = password_hash');
    assert.match(err.hint ?? '', /desna strana/);
  });

  test('kast se odbija', () => {
    rejects("product_id = 'x'::text");
  });

  test('kraj naredbe se odbija', () => {
    rejects('deleted_at IS NULL; DROP TABLE users');
  });

  test('komentari se odbijaju u oba oblika', () => {
    assert.match(rejects('1=1 -- ostatak').message, /Komentari/);
    assert.match(rejects('deleted_at IS NULL /* pa */').message, /Komentari/);
  });

  test('apostrof u literalu ne može da izađe iz literala', () => {
    // Vrednost ostaje vrednost: ide kao parametar, ne u tekst upita.
    const { sql, params } = render("name = 'O''Brien'");
    assert.equal(sql, '"name" = $1');
    assert.deepEqual(params, ["O'Brien"]);
  });

  test('nezatvoren literal se odbija umesto da proguta ostatak', () => {
    rejects("name = 'nezatvoreno");
  });
});

describe('ispravni uslovi', () => {
  test('IS NULL i IS NOT NULL', () => {
    assert.equal(render('deleted_at IS NULL').sql, '"deleted_at" IS NULL');
    assert.equal(render('deleted_at IS NOT NULL').sql, '"deleted_at" IS NOT NULL');
  });

  test('poređenja vezuju vrednost kao parametar', () => {
    const { sql, params } = render('price_rsd >= 1000');
    assert.equal(sql, '"price_rsd" >= $1');
    assert.deepEqual(params, [1000]);
  });

  test('!= se normalizuje u <>', () => {
    assert.equal(render("category_slug != 'x'").sql, '"category_slug" <> $1');
  });

  test('AND i OR se zagrađuju da prioritet ne zavisi od baze', () => {
    const { sql } = render("a = 1 OR b = 2 AND c = 3");
    assert.equal(sql, '("a" = $1 OR ("b" = $2 AND "c" = $3))');
  });

  test('zagrade iz uslova se poštuju', () => {
    const { sql } = render('(a = 1 OR b = 2) AND c = 3');
    assert.equal(sql, '(("a" = $1 OR "b" = $2) AND "c" = $3)');
  });

  test('NOT', () => {
    assert.equal(render('NOT in_stock = TRUE').sql, '(NOT "in_stock" = $1)');
  });

  test('IN i NOT IN', () => {
    const inList = render("category_slug IN ('a', 'b', 'c')");
    assert.equal(inList.sql, '"category_slug" IN ($1, $2, $3)');
    assert.deepEqual(inList.params, ['a', 'b', 'c']);

    assert.equal(render("category_slug NOT IN ('a')").sql, '"category_slug" NOT IN ($1)');
  });

  test('LIKE, NOT LIKE i ILIKE', () => {
    assert.equal(render("name LIKE 'sve%'").sql, '"name" LIKE $1');
    assert.equal(render("name NOT LIKE 'sve%'").sql, '"name" NOT LIKE $1');
    assert.equal(render("name ILIKE '%svećice%'").sql, '"name" ILIKE $1');
  });

  test('TRUE i FALSE kao samostalni uslovi', () => {
    assert.equal(render('TRUE').sql, 'TRUE');
    assert.equal(render('FALSE').sql, 'FALSE');
  });

  test('ključne reči su neosetljive na veličinu slova', () => {
    assert.equal(render('deleted_at is null and in_stock = true').sql, '("deleted_at" IS NULL AND "in_stock" = $1)');
  });

  test('svi identifikatori su pod navodnicima', () => {
    const { sql } = render("deleted_at IS NULL AND category_slug IN ('a')");
    for (const column of ['deleted_at', 'category_slug']) {
      assert.ok(sql.includes(`"${column}"`), `kolona ${column} nije pod navodnicima: ${sql}`);
    }
  });
});

describe('poruke o grešci', () => {
  test('greška nosi poziciju u uslovu', () => {
    const err = rejects('deleted_at IS NULL AND ???');
    assert.ok(err.offset > 20, `očekivana pozicija pri kraju, dobijena ${err.offset}`);
  });

  test('prazan uslov se odbija', () => {
    rejects('   ');
  });

  test('nezatvorena zagrada se odbija', () => {
    rejects('(a = 1');
  });

  test('IS bez NULL se odbija', () => {
    assert.match(rejects('a IS 5').message, /NULL/);
  });
});

describe('columnsOf', () => {
  test('prikuplja sve pročitane kolone', () => {
    const expr = parseWhere("deleted_at IS NULL AND (price_rsd < 100 OR category_slug IN ('a'))");
    assert.deepEqual(columnsOf(expr), ['category_slug', 'deleted_at', 'price_rsd']);
  });

  test('konstantan uslov nema kolona, pa kompajler ima šta da prijavi', () => {
    assert.deepEqual(columnsOf(parseWhere('TRUE')), []);
  });
});
