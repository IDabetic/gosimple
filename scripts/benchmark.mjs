/**
 * Measures query latency across catalogue sizes.
 *
 *   node scripts/benchmark.mjs                # 1k, 10k, 100k
 *   node scripts/benchmark.mjs 1000000        # one specific size
 *
 * Reports p50, p95 and p99 rather than an average, because an average hides
 * exactly the behaviour that matters: the slow tail is what users notice and
 * what fills the error budget.
 *
 * Build time is measured separately from query time. They scale differently
 * and conflating them makes an index look either better or worse than it is.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.ts';
import { compile } from '../src/compile.ts';
import { Engine } from '../src/runtime/execute.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const program = readFileSync(join(root, 'examples', 'prodavnica.gs'), 'utf8')
  // The synthetic catalogue is loaded directly, so the source declaration is
  // irrelevant here; only the taxonomy, intent and engine matter.
  .replace(/^source .*$/m, 'source products from "catalog.json"');

const { plan } = compile(parse(program, 'bench.gs'), program, 'bench.gs');

/**
 * Queries chosen to exercise different paths, not to flatter the numbers:
 * an ambiguous term that hits three categories, a locked intent, a term with
 * one match, and a term that matches nothing at all.
 */
const QUERIES = [
  'svećice',
  'svećice za Subaru',
  'solarne svećice za baštu',
  'LED sijalica E27',
  'bušilica akumulatorska',
  'frižider ugradni',
  'kvantni teleportator',
];

const NOW = '2026-12-15T10:00:00Z';

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function fmt(ms) {
  return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;
}

async function measure(size) {
  const json = execFileSync(
    process.execPath,
    [join(root, 'scripts', 'generate-catalog.mjs'), String(size)],
    { maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8' },
  );
  const docs = JSON.parse(json);

  const buildStart = performance.now();
  const engine = await Engine.create(plan, docs);
  const buildMs = performance.now() - buildStart;

  // Warm up so the first measured query is not paying for JIT compilation.
  for (let i = 0; i < 20; i++) {
    await engine.search({ query: QUERIES[i % QUERIES.length], now: NOW });
  }

  const samples = [];
  const iterations = size >= 500_000 ? 200 : 1000;

  for (let i = 0; i < iterations; i++) {
    const query = QUERIES[i % QUERIES.length];
    const t0 = performance.now();
    await engine.search({ query, now: NOW });
    samples.push(performance.now() - t0);
  }

  samples.sort((a, b) => a - b);

  const heap = process.memoryUsage().heapUsed / 1024 / 1024;

  return {
    size,
    buildMs,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    heapMb: heap,
  };
}

const sizes = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [1_000, 10_000, 100_000];

console.log('');
console.log('  katalog      build       p50        p95        p99      heap');
console.log('  ───────────────────────────────────────────────────────────────');

for (const size of sizes) {
  const r = await measure(size);
  console.log(
    `  ${String(r.size).padStart(8)}  ${fmt(r.buildMs).padStart(9)}  ` +
      `${fmt(r.p50).padStart(9)}  ${fmt(r.p95).padStart(9)}  ${fmt(r.p99).padStart(9)}  ` +
      `${r.heapMb.toFixed(0).padStart(5)} MB`,
  );
  global.gc?.();
}

console.log('');
