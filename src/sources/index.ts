/**
 * Source adapters.
 *
 * A source turns whatever the application already stores into GoSimple
 * documents. The engine never learns which backend it is reading from, so a
 * program written against a JSON file runs unchanged against PostgreSQL once
 * the source declaration changes.
 */

import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { parseWhere, toSql, WhereParseError } from './where.ts';
import type { IRSource } from '../ir.ts';
import type { Doc } from '../runtime/execute.ts';

export interface SourceAdapter {
  /** Loads the full document set. */
  load(): Promise<Doc[]>;
  /** Human-readable description for logs and the health endpoint. */
  describe(): string;
  /** Releases connections. Safe to call more than once. */
  close(): Promise<void>;
}

export class SourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SourceError';
  }
}

/** Coerces a raw row value into the type the engine expects for that field. */
function coerce(field: string, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;

  switch (field) {
    case 'id':
      return String(value);
    case 'title':
    case 'description':
    case 'category':
    case 'brand':
    case 'vendor':
      return String(value);
    case 'price':
    case 'views':
    case 'purchases': {
      const num = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(num) ? num : undefined;
    }
    case 'available':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      return !['false', '0', 'f', 'no', ''].includes(String(value).toLowerCase());
    case 'createdAt':
      return value instanceof Date ? value.toISOString() : String(value);
    case 'tags':
      if (Array.isArray(value)) return value.map(String);
      if (typeof value === 'string') {
        const trimmed = value.trim();
        // Postgres text[] arrives as `{a,b}` through some drivers.
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          return trimmed
            .slice(1, -1)
            .split(',')
            .map((s) => s.replace(/^"|"$/g, '').trim())
            .filter(Boolean);
        }
        return trimmed ? trimmed.split(',').map((s) => s.trim()).filter(Boolean) : [];
      }
      return [];
    default:
      return value;
  }
}

/** Builds a Doc from a raw row using the declared column mapping. */
export function mapRow(row: Record<string, unknown>, columns: Record<string, string>): Doc | null {
  const doc: Record<string, unknown> = {};

  for (const [field, column] of Object.entries(columns)) {
    const coerced = coerce(field, row[column]);
    if (coerced !== undefined) doc[field] = coerced;
  }

  // A document missing any of these cannot be searched, ranked or explained.
  if (typeof doc.id !== 'string' || !doc.id) return null;
  if (typeof doc.title !== 'string' || !doc.title) return null;
  if (typeof doc.category !== 'string' || !doc.category) return null;

  return doc as Doc;
}

class JsonSource implements SourceAdapter {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<Doc[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      throw new SourceError(`Ne mogu da pročitam izvor "${this.path}"`, { cause: err });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SourceError(`Izvor "${this.path}" nije validan JSON`, { cause: err });
    }
    if (!Array.isArray(parsed)) {
      throw new SourceError(`Izvor "${this.path}" mora da bude JSON niz dokumenata`);
    }

    const docs: Doc[] = [];
    parsed.forEach((row, index) => {
      const doc = row as Partial<Doc>;
      if (!doc.id || !doc.title || !doc.category) {
        throw new SourceError(
          `Dokument na poziciji ${index} u "${this.path}" nema obavezna polja id, title i category`,
        );
      }
      docs.push(doc as Doc);
    });
    return docs;
  }

  describe(): string {
    // Only the file name. `describe()` is surfaced on /health, and the
    // absolute path would disclose the server's directory layout and the
    // account it runs under to anyone allowed to call that endpoint.
    return `json:${basename(this.path)}`;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

/**
 * PostgreSQL adapter.
 *
 * Table and column names are validated as plain identifiers by the compiler
 * and double-quoted here. They cannot be bound as parameters, so quoting plus
 * a compile-time allowlist is the correct handling; the belt-and-braces check
 * below exists so a hand-built plan cannot bypass the compiler.
 */
/** Minimal surface of `pg.Pool` that this adapter relies on. */
type PgPool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};

type PgModule = {
  Pool: new (options: {
    connectionString: string;
    max: number;
    connectionTimeoutMillis: number;
  }) => PgPool;
};

class PostgresSource implements SourceAdapter {
  private config: IRSource;
  private pool: PgPool | null = null;

  private static readonly SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

  constructor(config: IRSource) {
    this.config = config;
  }

  private static quote(identifier: string): string {
    if (!PostgresSource.SAFE_IDENTIFIER.test(identifier)) {
      throw new SourceError(`Nedozvoljen SQL identifikator "${identifier}"`);
    }
    return `"${identifier}"`;
  }

  /**
   * Builds the SELECT and its bound parameters.
   *
   * The where clause is parsed into an expression tree and rendered from
   * that tree, never concatenated. See src/sources/where.ts for why: the
   * previous blocklist let `false UNION SELECT ... FROM users` straight
   * through, which was reproduced against a live database.
   *
   * Exposed for testing so the exact SQL and parameters can be asserted.
   */
  buildQuery(): { text: string; values: unknown[] } {
    const { columns, table, where, limit } = this.config;
    if (!table) throw new SourceError('PostgreSQL izvor nema navedenu tabelu');

    const projection = Object.values(columns)
      .map((column) => PostgresSource.quote(column))
      .join(', ');

    const values: unknown[] = [];
    let text = `SELECT ${projection} FROM ${PostgresSource.quote(table)}`;

    if (where) {
      try {
        text += ` WHERE ${toSql(parseWhere(where), values)}`;
      } catch (err) {
        if (err instanceof WhereParseError) {
          throw new SourceError(`Neispravan where uslov: ${err.message}`, { cause: err });
        }
        throw err;
      }
    }

    // Always bounded, so a runaway table cannot exhaust memory on startup.
    text += ` LIMIT ${Math.max(1, Math.floor(limit ?? 100_000))}`;
    return { text, values };
  }

  private async connect(): Promise<PgPool> {
    if (this.pool) return this.pool;

    // `pg` is an optional dependency, so the specifier is held in a variable:
    // a literal would make TypeScript require the package to be installed in
    // order to typecheck a project that uses only JSON sources.
    const specifier = 'pg';
    let pg: PgModule;
    try {
      pg = (await import(specifier)) as PgModule;
    } catch (err) {
      throw new SourceError(
        'PostgreSQL izvor zahteva paket "pg". Instalirajte ga sa: npm install pg',
        { cause: err },
      );
    }

    this.pool = new pg.Pool({
      connectionString: expandEnv(this.config.uri),
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    return this.pool;
  }

  async load(): Promise<Doc[]> {
    const pool = await this.connect();
    const { text, values } = this.buildQuery();

    let rows: Array<Record<string, unknown>>;
    try {
      ({ rows } = await pool.query(text, values));
    } catch (err) {
      throw new SourceError(`PostgreSQL upit nije uspeo: ${(err as Error).message}`, { cause: err });
    }

    const docs: Doc[] = [];
    let skipped = 0;
    for (const row of rows) {
      const doc = mapRow(row, this.config.columns);
      if (doc) docs.push(doc);
      else skipped++;
    }

    if (skipped > 0) {
      console.warn(
        `[gosimple] ${skipped} redova je preskočeno jer nemaju id, title ili category.`,
      );
    }
    return docs;
  }

  describe(): string {
    // The connection string may carry credentials, so only the host is shown.
    let host = 'postgres';
    try {
      // Expanded so the real host is shown, then reduced to host only:
      // the expansion may well have carried a password.
      host = new URL(expandEnv(this.config.uri)).host || host;
    } catch {
      // Malformed URI is reported on connect, not here.
    }
    return `postgres://${host}/${this.config.table}`;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

/**
 * Substitutes `${VAR}` references from the environment.
 *
 * A connection string written out in full lives in a `.gs` file, and `.gs`
 * files go into git — so the password goes into git with it. Interpolation
 * happens here rather than at compile time on purpose: the IR plan keeps the
 * `${VAR}` text, so `gs plan` and `GET /plan` can be shared without leaking
 * anything, and the same plan works across environments.
 */
export function expandEnv(uri: string, env: NodeJS.ProcessEnv = process.env): string {
  const missing: string[] = [];

  const expanded = uri.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  });

  if (missing.length > 0) {
    const names = [...new Set(missing)];
    throw new SourceError(
      `Promenljiv${names.length === 1 ? 'a' : 'e'} okruženja ${names.map((n) => `"${n}"`).join(', ')} ` +
        `${names.length === 1 ? 'nije postavljena' : 'nisu postavljene'}, a izvor ${names.length === 1 ? 'je' : 'ih'} koristi.`,
    );
  }

  return expanded;
}

/**
 * Chooses an adapter from the source URI.
 *
 * The scheme is read from the raw URI, before interpolation, so that the
 * compiler can tell a JSON source from a SQL one without the environment
 * being present.
 *
 * @param baseDir directory the program was loaded from; relative file paths
 *                resolve against it rather than the process working directory
 */
export function createSource(config: IRSource, baseDir: string): SourceAdapter {
  if (/^postgres(ql)?:\/\//i.test(config.uri)) {
    return new PostgresSource(config);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(config.uri)) {
    const scheme = config.uri.slice(0, config.uri.indexOf(':'));
    throw new SourceError(
      `Nepodržan izvor "${scheme}://". v0.1 podržava JSON fajlove i postgres://.`,
    );
  }
  const path = expandEnv(config.uri);
  return new JsonSource(isAbsolute(path) ? path : resolve(baseDir, path));
}

export { JsonSource, PostgresSource };
