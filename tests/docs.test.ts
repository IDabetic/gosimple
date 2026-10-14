import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function readAllSources(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out += readAllSources(path);
    else if (entry.name.endsWith('.ts')) out += readFileSync(path, 'utf8');
  }
  return out;
}

const code = readAllSources(join(root, 'src'));
const spec = readFileSync(join(root, 'SPEC.md'), 'utf8');

/**
 * Documentation drifts away from the code faster than anything else in a
 * project, and a diagnostic table that lists codes the compiler no longer
 * emits is worse than no table — it sends people looking for the wrong thing.
 * These tests make the drift a build failure instead of a surprise.
 */
describe('dokumentacija prati kod', () => {
  test('svaki dijagnostički kod iz kompajlera je opisan u SPEC.md', () => {
    const emitted = new Set([...code.matchAll(/'(GS\d{4})'/g)].map((m) => m[1]!));
    const documented = new Set([...spec.matchAll(/`(GS\d{4})`/g)].map((m) => m[1]!));

    const missing = [...emitted].filter((c) => !documented.has(c)).sort();
    assert.deepEqual(missing, [], `kodovi bez opisa u SPEC.md: ${missing.join(', ')}`);
  });

  test('SPEC.md ne opisuje kodove koje kompajler ne emituje', () => {
    const emitted = new Set([...code.matchAll(/'(GS\d{4})'/g)].map((m) => m[1]!));
    const documented = new Set([...spec.matchAll(/`(GS\d{4})`/g)].map((m) => m[1]!));

    const stale = [...documented].filter((c) => !emitted.has(c)).sort();
    assert.deepEqual(stale, [], `SPEC.md opisuje nepostojeće kodove: ${stale.join(', ')}`);
  });

  test('examples/schema.sql odgovara catalog.json', () => {
    // Dva opisa istog kataloga se razilaze čim se održavaju ručno, a jednom
    // su se i razišla: prekucan opis je promenio content_quality toliko da
    // je isti upit drugačije rangirao iz JSON-a nego iz baze.
    const before = readFileSync(join(root, 'examples', 'schema.sql'), 'utf8');
    execFileSync(process.execPath, [join(root, 'scripts', 'generate-schema.mjs')], { cwd: root });
    const after = readFileSync(join(root, 'examples', 'schema.sql'), 'utf8');

    assert.equal(
      after,
      before,
      'examples/schema.sql je zastareo — pokrenite `node scripts/generate-schema.mjs`',
    );
  });

  test('svi primeri se kompajliraju bez grešaka', () => {
    const dir = join(root, 'examples');
    const programs = readdirSync(dir).filter((f) => f.endsWith('.gs'));

    assert.ok(programs.length > 0, 'nema primera za proveru');

    for (const file of programs) {
      const text = readFileSync(join(dir, file), 'utf8');
      assert.doesNotThrow(() => compile(parse(text, file), text, file), `primer "${file}" se ne kompajlira`);
    }
  });
});
