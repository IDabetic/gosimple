/**
 * Diagnostics carry enough context to render a pointed, actionable error.
 *
 * Every diagnostic answers four questions: what broke, where, why it is
 * invalid, and what to do about it. The `hint` field is not decoration — the
 * checker is expected to fill it with a concrete suggestion whenever it can
 * compute one (nearest valid name, allowed range, required clause).
 */

import type { Span } from './ast.ts';

export type Severity = 'error' | 'warning';

export type Diagnostic = {
  severity: Severity;
  code: string;
  message: string;
  span: Span;
  hint?: string;
};

export class GoSimpleError extends Error {
  diagnostics: Diagnostic[];
  source: string;
  file: string;

  constructor(diagnostics: Diagnostic[], source: string, file: string) {
    super(diagnostics[0]?.message ?? 'Greška pri kompilaciji');
    this.name = 'GoSimpleError';
    this.diagnostics = diagnostics;
    this.source = source;
    this.file = file;
  }
}

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

/** Renders diagnostics with the offending source line and a caret. */
export function formatDiagnostics(
  diagnostics: Diagnostic[],
  source: string,
  file: string,
  color = true,
): string {
  const lines = source.split('\n');
  const c = (code: string, text: string) => (color ? code + text + RESET : text);

  return diagnostics
    .map((d) => {
      const label = d.severity === 'error' ? c(RED, 'greška') : c(YELLOW, 'upozorenje');
      const head = `${label} [${d.code}]: ${c(BOLD, d.message)}`;
      const loc = c(DIM, `  --> ${file}:${d.span.line}:${d.span.col}`);

      const srcLine = lines[d.span.line - 1];
      const body =
        srcLine === undefined
          ? ''
          : `\n${c(DIM, '   |')}\n${c(DIM, String(d.span.line).padStart(3) + '|')} ${srcLine}\n` +
            `${c(DIM, '   |')} ${' '.repeat(Math.max(0, d.span.col - 1))}${c(RED, '^')}`;

      const hint = d.hint ? `\n${c(DIM, '   =')} ${c(BOLD, 'pomoć:')} ${d.hint}` : '';
      return `${head}\n${loc}${body}${hint}`;
    })
    .join('\n\n');
}

/** Levenshtein distance, used to suggest the closest valid name. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Returns the closest candidate within a sane distance, or null. */
export function suggest(name: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  const limit = Math.max(2, Math.floor(name.length / 2));

  for (const candidate of candidates) {
    const score = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= limit ? best : null;
}
