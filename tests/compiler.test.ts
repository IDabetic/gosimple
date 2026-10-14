import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { GoSimpleError } from '../src/diagnostics.ts';
import { tokenize } from '../src/lexer.ts';

const MINIMAL = `
source products from "catalog.json"

taxonomy {
  category "a" { terms ["x"] signals ["sa"] }
  category "b" { terms ["x"] signals ["sb"] season [zima] }
}

intent I {
  rule "ra" { when signal of "a" then category "a" confidence 0.9 lock }
  fallback ambiguous when confidence < 0.6
}

engine E {
  use source products
  use intent I
  search {
    retrieve 100 candidates
    match { keywords weight 1.0 }
    rank by { query_relevance 0.6  seasonal_relevance 0.4 }
    protect intent
    return top 5
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
    assert.ok(err instanceof GoSimpleError, `Očekivan GoSimpleError, dobijeno ${err}`);
    const codes = err.diagnostics.map((d) => d.code);
    assert.ok(codes.includes(code), `Očekivan kod ${code}, dobijeni: ${codes.join(', ')}`);
    return err;
  }
  throw new Error('unreachable');
}

describe('lexer', () => {
  test('tokenizuje brojeve, stringove i interpunkciju', () => {
    const tokens = tokenize('retrieve 300 from "a.json" { }');
    assert.deepEqual(
      tokens.map((t) => t.kind),
      ['ident', 'number', 'ident', 'string', '{', '}', 'eof'],
    );
    assert.equal(tokens[1]!.value, 300);
    assert.equal(tokens[3]!.value, 'a.json');
  });

  test('ignoriše komentare i podržava unicode identifikatore', () => {
    const tokens = tokenize('# komentar\nkategorija // još jedan\n');
    assert.deepEqual(tokens.map((t) => t.kind), ['ident', 'eof']);
    assert.equal(tokens[0]!.text, 'kategorija');
  });

  test('odbija nezatvoren string', () => {
    assert.throws(() => tokenize('source a from "nezatvoren'), /Nezatvoren string/);
  });

  test('decimalni brojevi se parsiraju tačno', () => {
    const tokens = tokenize('0.35');
    assert.equal(tokens[0]!.value, 0.35);
  });
});

describe('compiler — ispravni programi', () => {
  test('kompajlira minimalan program', () => {
    const { plan } = compileSource(MINIMAL);
    assert.equal(plan.engine, 'E');
    assert.equal(plan.irVersion, 1);
    assert.equal(plan.categories.length, 2);
    assert.equal(plan.intent?.rules.length, 1);
  });

  test('gradi invertovane indekse za termine i signale', () => {
    const { plan } = compileSource(MINIMAL);
    // "x" je dvosmislen: pripada i kategoriji a i kategoriji b.
    assert.deepEqual(plan.indexes.termToCategories['x']?.sort(), ['a', 'b']);
    assert.equal(plan.indexes.signalToCategory['sa'], 'a');
    assert.deepEqual(plan.indexes.seasonToCategories['zima'], ['b']);
  });

  test('izvor se izvodi automatski kada postoji tačno jedan', () => {
    const source = MINIMAL.replace('  use source products\n', '');
    const { plan } = compileSource(source);
    assert.equal(plan.source.name, 'products');
  });
});

describe('compiler — dijagnostika', () => {
  test('GS2008: protect intent bez deklarisanog intenta je greška', () => {
    const source = MINIMAL.replace('  use intent I\n', '').replace(
      /intent I \{[\s\S]*?\n\}\n/,
      '',
    );
    const err = expectError(source, 'GS2008');
    const diagnostic = err.diagnostics.find((d) => d.code === 'GS2008')!;
    assert.match(diagnostic.hint ?? '', /sezonski signali/i);
  });

  test('GS2010: retrieve manji od return top je greška', () => {
    expectError(MINIMAL.replace('retrieve 100 candidates', 'retrieve 3 candidates'), 'GS2010');
  });

  test('GS2004: nepoznat rank signal nudi najbližu ispravnu vrednost', () => {
    const err = expectError(
      MINIMAL.replace('query_relevance 0.6', 'query_relevence 0.6'),
      'GS2004',
    );
    const diagnostic = err.diagnostics.find((d) => d.code === 'GS2004')!;
    assert.match(diagnostic.hint ?? '', /query_relevance/);
  });

  test('GS2003: pravilo koje referencira nepostojeću kategoriju', () => {
    expectError(MINIMAL.replace('when signal of "a"', 'when signal of "nepostojeca"'), 'GS2003');
  });

  test('GS2011: duplirana kategorija', () => {
    const source = MINIMAL.replace(
      'category "b" { terms ["x"] signals ["sb"] season [zima] }',
      'category "a" { terms ["y"] signals ["sb"] }',
    );
    expectError(source, 'GS2011');
  });

  test('GS2013: ponovljen rank signal', () => {
    expectError(
      MINIMAL.replace('rank by { query_relevance 0.6  seasonal_relevance 0.4 }', 'rank by { query_relevance 0.6  query_relevance 0.4 }'),
      'GS2013',
    );
  });

  test('GS2006: zbir težina različit od 1.0 daje upozorenje, ne grešku', () => {
    const { warnings } = compileSource(MINIMAL.replace('seasonal_relevance 0.4', 'seasonal_relevance 0.9'));
    assert.ok(warnings.some((w) => w.code === 'GS2006'));
  });

  test('GS2103: sezonski signal bez protect intent daje upozorenje', () => {
    const { warnings } = compileSource(MINIMAL.replace('    protect intent\n', ''));
    assert.ok(
      warnings.some((w) => w.code === 'GS2103'),
      'očekivano upozorenje da sezona može da potisne nameru',
    );
  });

  test('GS2105: semantic match polje upozorava da adapter nedostaje', () => {
    const { warnings } = compileSource(
      MINIMAL.replace('match { keywords weight 1.0 }', 'match { keywords weight 1.0  semantic weight 0.5 }'),
    );
    assert.ok(warnings.some((w) => w.code === 'GS2105'));
  });

  test('sintaksna greška prijavljuje tačnu liniju', () => {
    const broken = 'source products from "a.json"\nengine E {\n  search {\n    retrieve\n  }\n}\n';
    try {
      compileSource(broken);
      assert.fail('očekivana sintaksna greška');
    } catch (err) {
      assert.ok(err instanceof GoSimpleError);
      assert.equal(err.diagnostics[0]!.span.line, 5);
    }
  });
});
