import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { Engine, type Doc } from '../src/runtime/execute.ts';
import {
  cosineSimilarity,
  createEmbeddingProvider,
  LocalEmbedding,
  OpenAIEmbedding,
  type EmbeddingProvider,
} from '../src/runtime/embed.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples');

describe('lokalni embedding', () => {
  const provider = new LocalEmbedding();

  test('vektori su L2-normalizovani', async () => {
    const [vector] = await provider.embed(['svećice za Subaru']);
    let sum = 0;
    for (const value of vector!) sum += value * value;
    assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-5, `norma je ${Math.sqrt(sum)}`);
  });

  test('isti tekst uvek daje isti vektor', async () => {
    const [a] = await provider.embed(['baštenska rasveta']);
    const [b] = await provider.embed(['baštenska rasveta']);
    assert.deepEqual(Array.from(a!), Array.from(b!));
  });

  test('ćirilica i latinica daju isti vektor', async () => {
    const [latin] = await provider.embed(['svećice za Subaru']);
    const [cyrillic] = await provider.embed(['свећице за Субару']);
    // Oba pisma proizvode identične tokene; preostala razlika je samo šum
    // akumulacije u float32, pa poređenje ide sa tolerancijom.
    assert.ok(
      1 - cosineSimilarity(latin!, cyrillic!) < 1e-5,
      `sličnost je ${cosineSimilarity(latin!, cyrillic!)}`,
    );
  });

  test('padeži iste reči su bliži nego nepovezane reči', async () => {
    const [base, inflected, unrelated] = await provider.embed([
      'svećica',
      'svećicama',
      'akumulator',
    ]);

    const close = cosineSimilarity(base!, inflected!);
    const far = cosineSimilarity(base!, unrelated!);
    assert.ok(close > far, `padež ${close.toFixed(3)} nije bliži od nepovezanog ${far.toFixed(3)}`);
  });

  test('greška u kucanju ostaje blizu ispravnog oblika', async () => {
    const [correct, typo, unrelated] = await provider.embed(['akumulator', 'akumlator', 'jelka']);
    assert.ok(cosineSimilarity(correct!, typo!) > cosineSimilarity(correct!, unrelated!));
  });

  test('redosled batch-a se čuva', async () => {
    const texts = ['prvi', 'drugi', 'treći'];
    const batch = await provider.embed(texts);
    for (let i = 0; i < texts.length; i++) {
      const [single] = await provider.embed([texts[i]!]);
      assert.deepEqual(Array.from(batch[i]!), Array.from(single!));
    }
  });

  test('prazan tekst ne ruši provajder', async () => {
    const [vector] = await provider.embed(['']);
    assert.equal(vector!.length, provider.dimensions);
  });

  test('provajder se izjašnjava kao leksički, ne semantički', () => {
    assert.equal(provider.kind, 'lexical-vector');
  });
});

describe('kosinusna sličnost', () => {
  test('identični vektori daju 1', () => {
    const v = Float32Array.from([0.6, 0.8]);
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6);
  });

  test('ortogonalni vektori daju 0', () => {
    assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  });

  test('negativna sličnost se odseca na 0', () => {
    assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([-1, 0])), 0);
  });

  test('različite dimenzije daju 0 umesto greške', () => {
    assert.equal(cosineSimilarity(Float32Array.from([1]), Float32Array.from([1, 0])), 0);
  });
});

describe('izbor provajdera', () => {
  test('podrazumevano je lokalni provajder', () => {
    assert.equal(createEmbeddingProvider({}).name, 'local');
  });

  test('openai bez ključa daje jasnu poruku', () => {
    assert.throws(
      () => createEmbeddingProvider({ GOSIMPLE_EMBEDDING: 'openai' }),
      /OPENAI_API_KEY/,
    );
  });

  test('nepoznat provajder nabraja dostupne', () => {
    assert.throws(() => createEmbeddingProvider({ GOSIMPLE_EMBEDDING: 'magija' }), /local, openai/);
  });

  test('openai provajder se izjašnjava kao semantički', () => {
    const provider = new OpenAIEmbedding({ apiKey: 'test-kljuc' });
    assert.equal(provider.kind, 'semantic');
    assert.match(provider.name, /^openai:/);
  });

  test('samostalno hostovan endpoint je samo promena base URL-a', () => {
    const provider = new OpenAIEmbedding({
      apiKey: 'x',
      baseUrl: 'http://localhost:11434/v1',
      model: 'nomic-embed-text',
    });
    assert.equal(provider.name, 'openai:nomic-embed-text');
  });
});

describe('semantička pretraga u engine-u', () => {
  const source = readFileSync(join(examples, 'semanticka.gs'), 'utf8');
  const { plan } = compile(parse(source, 'semanticka.gs'), source, 'semanticka.gs');
  const docs = JSON.parse(readFileSync(join(examples, 'catalog.json'), 'utf8')) as Doc[];

  test('bez provajdera semantika je isključena, a to je vidljivo u odgovoru', async () => {
    const engine = await Engine.create(plan, docs);
    const result = await engine.search({ query: 'svećice', now: '2026-07-01T00:00:00Z' });
    assert.equal(result.vectorMode, 'off');
  });

  test('sa lokalnim provajderom režim se prijavljuje kao leksički vektor', async () => {
    const engine = await Engine.create(plan, docs, { embedding: new LocalEmbedding() });
    const result = await engine.search({ query: 'svećice', now: '2026-07-01T00:00:00Z' });
    assert.equal(result.vectorMode, 'lexical-vector');
  });

  test('vektorsko poklapanje pronalazi proizvod i kada tačna reč nedostaje', async () => {
    const engine = await Engine.create(plan, docs, { embedding: new LocalEmbedding() });
    // "akumlator" je pogrešno otkucano i ne postoji ni u jednom opisu.
    const result = await engine.search({ query: 'solarno osvetljenje', now: '2026-07-01T00:00:00Z' });
    assert.ok(result.hits.length > 0, 'vektorska faza nije pronašla nijednog kandidata');
  });

  test('upit se embeduje samo jednom zahvaljujući kešu', async () => {
    let calls = 0;
    const counting: EmbeddingProvider = {
      name: 'counting',
      kind: 'lexical-vector',
      dimensions: 64,
      async embed(texts) {
        calls++;
        return texts.map(() => {
          const v = new Float32Array(64);
          v[0] = 1;
          return v;
        });
      },
    };

    const engine = await Engine.create(plan, docs, { embedding: counting });
    const afterIndex = calls;

    await engine.search({ query: 'isti upit', now: '2026-07-01T00:00:00Z' });
    await engine.search({ query: 'isti upit', now: '2026-07-01T00:00:00Z' });

    assert.equal(calls, afterIndex + 1, 'ponovljen upit je ponovo embedovan');
  });

  test('neispravan broj vektora iz provajdera se prijavljuje, ne ignoriše', async () => {
    const broken: EmbeddingProvider = {
      name: 'broken',
      kind: 'semantic',
      dimensions: 8,
      async embed() {
        return [new Float32Array(8)];
      },
    };
    await assert.rejects(() => Engine.create(plan, docs, { embedding: broken }), /vektora za/);
  });
});
