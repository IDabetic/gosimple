/**
 * GoSimple HTTP runtime.
 *
 * This is the integration surface: Laravel, Next.js, Nuxt and anything else
 * that speaks HTTP call this instead of embedding the engine.
 *
 * Security posture — what is actually enforced here, not what is aspirational:
 *
 *  1. The server never compiles a .gs program from a request. The plan is
 *     compiled once at startup from a file on disk. There is no code path
 *     from network input to the compiler, which removes the entire class of
 *     "attacker submits a malicious program" attacks rather than mitigating it.
 *  2. Request bodies are capped and the socket is destroyed on overflow, so a
 *     slow or oversized body cannot exhaust memory.
 *  3. Every field is validated against an explicit allowlist of types and
 *     bounds before it reaches the engine.
 *  4. A per-client token bucket limits request rate.
 *  5. Optional bearer token auth, compared in constant time.
 *  6. CORS is deny-by-default and opens only to an explicit origin allowlist.
 *  7. Error responses never echo internal paths or stack traces.
 *
 * What this does NOT claim: that the system is free of vulnerabilities. It
 * claims a small, auditable attack surface and named, testable controls.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Plan } from './ir.ts';
import { Engine, type Doc, type SearchRequest } from './runtime/execute.ts';
import { analyzeContent } from './runtime/content.ts';
import { createEmbeddingProvider } from './runtime/embed.ts';
import { Recommender, type Event, type RecommendRequest } from './runtime/recommend.ts';
import type { SourceAdapter } from './sources/index.ts';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_LENGTH = 512;
const MAX_INTERESTS = 32;
const MAX_SEEN_IDS = 500;
const MAX_SEED_IDS = 50;
const REQUEST_TIMEOUT_MS = 5_000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 300;

const VALID_SEASONS = new Set(['prolece', 'leto', 'jesen', 'zima']);

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Fixed-window counter per client. Sufficient for a single-process runtime. */
class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    if (entry.count >= RATE_LIMIT_MAX) return false;
    entry.count++;
    return true;
  }

  /** Drops expired buckets so the map cannot grow without bound. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Compare lengths without branching on secret content.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Telo zahteva je preveliko'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new HttpError(400, 'Greška pri čitanju zahteva')));
  });
}

function asString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new HttpError(400, `Polje "${field}" mora biti string`);
  if (value.length > maxLength) throw new HttpError(400, `Polje "${field}" prelazi ${maxLength} znakova`);
  return value;
}

function asOptionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, field, maxLength);
}

/** Validates the request body into a SearchRequest, rejecting anything unexpected. */
function parseSearchRequest(raw: unknown): SearchRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, 'Telo zahteva mora biti JSON objekat');
  }
  const body = raw as Record<string, unknown>;

  const request: SearchRequest = { query: asString(body.query, 'query', MAX_QUERY_LENGTH) };

  const season = asOptionalString(body.season, 'season', 16);
  if (season !== undefined) {
    if (!VALID_SEASONS.has(season)) {
      throw new HttpError(400, `Nepoznato godišnje doba "${season}"`);
    }
    request.season = season;
  }

  const now = asOptionalString(body.now, 'now', 40);
  if (now !== undefined) {
    if (Number.isNaN(Date.parse(now))) throw new HttpError(400, 'Polje "now" nije validan ISO datum');
    request.now = now;
  }

  if (body.user !== undefined && body.user !== null) {
    if (typeof body.user !== 'object' || Array.isArray(body.user)) {
      throw new HttpError(400, 'Polje "user" mora biti objekat');
    }
    const user = body.user as Record<string, unknown>;
    request.user = {};

    const id = asOptionalString(user.id, 'user.id', 128);
    if (id !== undefined) request.user.id = id;

    if (user.budget !== undefined && user.budget !== null) {
      if (typeof user.budget !== 'number' || !Number.isFinite(user.budget) || user.budget < 0) {
        throw new HttpError(400, 'Polje "user.budget" mora biti nenegativan broj');
      }
      request.user.budget = user.budget;
    }

    if (user.interests !== undefined && user.interests !== null) {
      if (!Array.isArray(user.interests)) throw new HttpError(400, 'Polje "user.interests" mora biti niz');
      if (user.interests.length > MAX_INTERESTS) {
        throw new HttpError(400, `Polje "user.interests" prelazi ${MAX_INTERESTS} stavki`);
      }
      request.user.interests = user.interests.map((v, i) => asString(v, `user.interests[${i}]`, 64));
    }

    if (user.seenIds !== undefined && user.seenIds !== null) {
      if (!Array.isArray(user.seenIds)) throw new HttpError(400, 'Polje "user.seenIds" mora biti niz');
      if (user.seenIds.length > MAX_SEEN_IDS) {
        throw new HttpError(400, `Polje "user.seenIds" prelazi ${MAX_SEEN_IDS} stavki`);
      }
      request.user.seenIds = user.seenIds.map((v, i) => asString(v, `user.seenIds[${i}]`, 128));
    }
  }

  return request;
}

/** Validates the recommend request body with the same strictness as search. */
function parseRecommendRequest(raw: unknown): RecommendRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, 'Telo zahteva mora biti JSON objekat');
  }
  const body = raw as Record<string, unknown>;
  const request: RecommendRequest = {};

  const userId = asOptionalString(body.userId, 'userId', 128);
  if (userId !== undefined) request.userId = userId;

  const season = asOptionalString(body.season, 'season', 16);
  if (season !== undefined) {
    if (!VALID_SEASONS.has(season)) throw new HttpError(400, `Nepoznato godišnje doba "${season}"`);
    request.season = season;
  }

  const now = asOptionalString(body.now, 'now', 40);
  if (now !== undefined) {
    if (Number.isNaN(Date.parse(now))) throw new HttpError(400, 'Polje "now" nije validan ISO datum');
    request.now = now;
  }

  if (body.budget !== undefined && body.budget !== null) {
    if (typeof body.budget !== 'number' || !Number.isFinite(body.budget) || body.budget < 0) {
      throw new HttpError(400, 'Polje "budget" mora biti nenegativan broj');
    }
    request.budget = body.budget;
  }

  for (const [field, limit] of [
    ['seedIds', MAX_SEED_IDS],
    ['excludeIds', MAX_SEEN_IDS],
    ['interests', MAX_INTERESTS],
  ] as const) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) throw new HttpError(400, `Polje "${field}" mora biti niz`);
    if (value.length > limit) throw new HttpError(400, `Polje "${field}" prelazi ${limit} stavki`);
    request[field] = value.map((v, i) => asString(v, `${field}[${i}]`, 128));
  }

  return request;
}

export async function startServer(
  plan: Plan,
  docs: Doc[],
  port: number,
  adapter?: SourceAdapter,
  events: Event[] = [],
): Promise<void> {
  const engine = await Engine.create(plan, docs, { embedding: createEmbeddingProvider() });
  const recommender = plan.recommend ? new Recommender(plan, docs, events) : null;
  const limiter = new RateLimiter();
  const sweeper = setInterval(() => limiter.sweep(), RATE_LIMIT_WINDOW_MS);
  sweeper.unref();

  const authToken = process.env.GOSIMPLE_TOKEN ?? null;
  const allowedOrigins = new Set(
    (process.env.GOSIMPLE_CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );

  const send = (res: ServerResponse, status: number, payload: unknown, origin: string | null) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    };
    if (origin && allowedOrigins.has(origin)) {
      headers['access-control-allow-origin'] = origin;
      headers['vary'] = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin ?? null;

    // Socket-level timeout, so a stalled client cannot hold a connection open.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());

    try {
      if (req.method === 'OPTIONS') {
        const headers: Record<string, string> = { 'content-length': '0' };
        if (origin && allowedOrigins.has(origin)) {
          headers['access-control-allow-origin'] = origin;
          headers['access-control-allow-methods'] = 'POST, GET, OPTIONS';
          headers['access-control-allow-headers'] = 'content-type, authorization';
          headers['access-control-max-age'] = '600';
          headers['vary'] = 'Origin';
        }
        res.writeHead(204, headers);
        res.end();
        return;
      }

      const clientKey = req.socket.remoteAddress ?? 'unknown';
      if (!limiter.check(clientKey)) {
        send(res, 429, { error: 'Previše zahteva' }, origin);
        return;
      }

      if (authToken !== null) {
        const header = req.headers.authorization ?? '';
        const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!constantTimeEqual(provided, authToken)) {
          send(res, 401, { error: 'Neispravan token' }, origin);
          return;
        }
      }

      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        send(
          res,
          200,
          {
            status: 'ok',
            engine: plan.engine,
            irVersion: plan.irVersion,
            documents: docs.length,
            source: adapter?.describe() ?? plan.source.uri,
          },
          origin,
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/plan') {
        send(res, 200, plan, origin);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/search') {
        const text = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new HttpError(400, 'Telo zahteva nije validan JSON');
        }
        const result = await engine.search(parseSearchRequest(parsed));
        send(res, 200, result, origin);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/recommend') {
        if (!recommender) {
          throw new HttpError(404, `Engine "${plan.engine}" nema recommend blok`);
        }
        const text = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new HttpError(400, 'Telo zahteva nije validan JSON');
        }
        send(res, 200, recommender.recommend(parseRecommendRequest(parsed)), origin);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/content') {
        const text = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new HttpError(400, 'Telo zahteva nije validan JSON');
        }
        const body = parsed as Record<string, unknown>;
        const content = asString(body.text, 'text', 20_000);
        send(res, 200, analyzeContent(content), origin);
        return;
      }

      send(res, 404, { error: 'Nepoznata putanja' }, origin);
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message }, origin);
        return;
      }
      // Internal failures are logged server-side and never leaked to the client.
      console.error('[gosimple] interna greška:', err);
      send(res, 500, { error: 'Interna greška' }, origin);
    }
  });

  // Caps concurrent sockets and header parsing time at the server level.
  server.maxConnections = 1024;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  // Graceful shutdown: stop accepting connections, then release the source.
  // A second signal exits immediately, so a wedged connection cannot trap the
  // process.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n[gosimple] ${signal} primljen, zatvaram...`);
    server.close();
    await adapter?.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  console.log(`GoSimple runtime "${plan.engine}" sluša na http://127.0.0.1:${port}`);
  console.log(`  POST /search    pretraga`);
  console.log(`  POST /recommend preporuke`);
  console.log(`  POST /content   analiza teksta`);
  console.log(`  GET  /plan      kompajlirani IR plan`);
  console.log(`  GET  /health    status`);
  console.log(
    authToken
      ? '  autentikacija: Bearer token je uključen'
      : '  autentikacija: isključena (postavite GOSIMPLE_TOKEN da je uključite)',
  );
  if (allowedOrigins.size === 0) {
    console.log('  CORS: zatvoren (postavite GOSIMPLE_CORS_ORIGINS da otvorite)');
  }
}
