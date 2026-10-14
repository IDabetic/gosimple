import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { createRuntime, type RuntimeHandle } from '../src/server.ts';
import type { Doc } from '../src/runtime/execute.ts';
import type { SourceAdapter } from '../src/sources/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples');

const source = readFileSync(join(examples, 'prodavnica.gs'), 'utf8');
const { plan } = compile(parse(source, 'prodavnica.gs'), source, 'prodavnica.gs');
const original = JSON.parse(readFileSync(join(examples, 'catalog.json'), 'utf8')) as Doc[];

class MemorySource implements SourceAdapter {
  docs: Doc[];
  loads = 0;
  delayMs = 0;

  constructor(docs: Doc[]) {
    this.docs = docs;
  }

  async load(): Promise<Doc[]> {
    this.loads++;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.docs;
  }

  describe(): string {
    return 'memory';
  }

  async close(): Promise<void> {}
}

const TOKEN = 'test-reload-token';

async function call(
  runtime: RuntimeHandle,
  method: string,
  path: string,
  options: { token?: string; body?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers,
    body: options.body,
  });
  return { status: response.status, body: await response.json() };
}

function withToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.GOSIMPLE_TOKEN;
  if (token === undefined) delete process.env.GOSIMPLE_TOKEN;
  else process.env.GOSIMPLE_TOKEN = token;

  return fn().finally(() => {
    if (previous === undefined) delete process.env.GOSIMPLE_TOKEN;
    else process.env.GOSIMPLE_TOKEN = previous;
  });
}

const handles: RuntimeHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.close();
  }
});

describe('POST /reload', () => {
  test('bez tokena je 403, i katalog se ne dira', async () => {
    const adapter = new MemorySource(original);
    const runtime = await withToken(undefined, () => createRuntime(plan, original, 0, adapter));
    handles.push(runtime);

    const response = await call(runtime, 'POST', '/reload');
    assert.equal(response.status, 403);
    assert.equal(adapter.loads, 0);

    const health = await call(runtime, 'GET', '/health');
    assert.equal((health.body as { documents: number }).documents, original.length);
  });

  test('pogrešan token je 401', async () => {
    const adapter = new MemorySource(original);
    const runtime = await withToken(TOKEN, () => createRuntime(plan, original, 0, adapter));
    handles.push(runtime);

    const response = await call(runtime, 'POST', '/reload', { token: 'nije-to' });
    assert.equal(response.status, 401);
    assert.equal(adapter.loads, 0);
  });

  test('telo zahteva se odbija, ne ignoriše', async () => {
    // Ako ovo ikada postane 200, neko je počeo da prima katalog preko mreže.
    const adapter = new MemorySource(original);
    const runtime = await withToken(TOKEN, () => createRuntime(plan, original, 0, adapter));
    handles.push(runtime);

    const response = await call(runtime, 'POST', '/reload', {
      token: TOKEN,
      body: JSON.stringify({
        documents: [{ id: 'ubacen-preko-mreze', title: 'Ne sme da uđe', category: 'auto-delovi' }],
      }),
    });

    assert.equal(response.status, 400);
    assert.match(String((response.body as { error: string }).error), /ne prima katalog/i);
    assert.equal(adapter.loads, 0);

    const search = await call(runtime, 'POST', '/search', {
      token: TOKEN,
      body: JSON.stringify({ query: 'ubacen-preko-mreze' }),
    });
    const hits = (search.body as { hits: Array<{ id: string }> }).hits;
    assert.ok(!hits.some((h) => h.id === 'ubacen-preko-mreze'));
  });

  test('ponovo čita izvor i pretraga vidi novi proizvod', async () => {
    const adapter = new MemorySource([...original]);
    const runtime = await withToken(TOKEN, () => createRuntime(plan, original, 0, adapter));
    handles.push(runtime);

    adapter.docs = [
      ...original,
      {
        id: 'nv-reload',
        title: 'Zimske gume 205/55 R16',
        description: 'Komplet od četiri zimske gume sa čeličnim felnama.',
        category: 'auto-delovi',
        views: 80,
        available: true,
      },
    ];

    const reloaded = await call(runtime, 'POST', '/reload', { token: TOKEN, body: '' });
    assert.equal(reloaded.status, 200);
    assert.deepEqual(reloaded.body, {
      status: 'ok',
      documents: original.length + 1,
      added: 1,
      updated: 0,
      removed: 0,
    });

    const search = await call(runtime, 'POST', '/search', {
      token: TOKEN,
      body: JSON.stringify({ query: 'zimske gume' }),
    });
    const hits = (search.body as { hits: Array<{ id: string }> }).hits;
    assert.ok(
      hits.some((h) => h.id === 'nv-reload'),
      `novi proizvod nije u rezultatima: ${hits.map((h) => h.id).join(', ')}`,
    );
  });

  test('dva istovremena zahteva dele jedno učitavanje', async () => {
    const adapter = new MemorySource(original);
    adapter.delayMs = 40;
    const runtime = await withToken(TOKEN, () => createRuntime(plan, original, 0, adapter));
    handles.push(runtime);

    const [a, b] = await Promise.all([
      call(runtime, 'POST', '/reload', { token: TOKEN, body: '' }),
      call(runtime, 'POST', '/reload', { token: TOKEN, body: '' }),
    ]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(adapter.loads, 1, `paralelni reload je pokrenuo izvor ${adapter.loads} puta`);
  });
});
