#!/usr/bin/env node
/**
 * GoSimple command line interface.
 *
 * gs check   <file>              parse + typecheck, report diagnostics
 * gs plan    <file>              print the compiled IR plan
 * gs run     <file> -q "upit"    execute a search and show ranked results
 * gs content <file>              content intelligence report for the catalog
 * gs serve   <file>              start the HTTP runtime
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from './parser.ts';
import { compile } from './compile.ts';
import { GoSimpleError, formatDiagnostics } from './diagnostics.ts';
import { Engine, type Doc } from './runtime/execute.ts';
import { createSource, type SourceAdapter } from './sources/index.ts';
import { createEmbeddingProvider } from './runtime/embed.ts';
import { parseEvents, Recommender, type Event } from './runtime/recommend.ts';
import { pluralArtikal, pluralGreska, pluralKategorija, pluralPravilo, pluralUpozorenje } from './plural.ts';
import type { Plan } from './ir.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

type Args = {
  command: string;
  file: string | null;
  query: string | null;
  season: string | null;
  now: string | null;
  port: number;
  json: boolean;
  budget: number | null;
  interests: string[];
  user: string | null;
  seed: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'help',
    file: null,
    query: null,
    season: null,
    now: null,
    port: 7777,
    json: false,
    budget: null,
    interests: [],
    user: null,
    seed: [],
  };

  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    switch (token) {
      case '-q':
      case '--query':
        args.query = rest[++i] ?? null;
        break;
      case '-s':
      case '--season':
        args.season = rest[++i] ?? null;
        break;
      case '--now':
        args.now = rest[++i] ?? null;
        break;
      case '-p':
      case '--port':
        args.port = Number(rest[++i] ?? 7777);
        break;
      case '--budget':
        args.budget = Number(rest[++i] ?? 0);
        break;
      case '--interests':
        args.interests = (rest[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '-u':
      case '--user':
        args.user = rest[++i] ?? null;
        break;
      case '--seed':
        args.seed = (rest[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--json':
        args.json = true;
        break;
      default:
        if (!token.startsWith('-') && args.file === null) args.file = token;
    }
  }
  return args;
}

async function loadProgram(file: string): Promise<{
  plan: Plan;
  docs: Doc[];
  events: Event[];
  adapter: SourceAdapter;
  warnings: ReturnType<typeof compile>['warnings'];
}> {
  const path = resolve(file);
  const source = await readFile(path, 'utf8');

  const program = parse(source, path);
  const { plan, warnings } = compile(program, source, path);

  const adapter = createSource(plan.source, dirname(path));
  const docs = await adapter.load();

  let events: Event[] = [];
  if (plan.events) {
    const eventsPath = resolve(dirname(path), plan.events.uri);
    try {
      events = parseEvents(JSON.parse(await readFile(eventsPath, 'utf8')));
    } catch (err) {
      throw new Error(`Ne mogu da učitam događaje iz "${eventsPath}": ${(err as Error).message}`);
    }
  }

  return { plan, docs, events, adapter, warnings };
}

function printWarnings(warnings: ReturnType<typeof compile>['warnings'], source: string, file: string) {
  if (warnings.length === 0) return;
  console.error(formatDiagnostics(warnings, source, file));
  console.error('');
}


function bar(value: number, width = 20): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width);
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    console.log(`${BOLD}GoSimple${RESET} v0.1 — jezik za pretragu, rangiranje i preporuke

${BOLD}Komande${RESET}
  gs check   <fajl.gs>                    provera sintakse i semantike
  gs plan    <fajl.gs>                    ispis kompajliranog IR plana
  gs run       <fajl.gs> -q "upit"        izvršavanje pretrage
  gs recommend <fajl.gs> -u <korisnik>    preporuke za korisnika
  gs content   <fajl.gs>                  analiza sadržaja kataloga
  gs serve     <fajl.gs> [-p 7777]        HTTP runtime za Laravel/Next/Vue

${BOLD}Opcije${RESET}
  -q, --query <tekst>      upit
  -u, --user <id>          korisnik za preporuke
      --seed <id,id>       artikli za "slično ovome"
  -s, --season <doba>      prolece | leto | jesen | zima
      --now <ISO datum>    fiksira "sada" radi ponovljivih testova
      --budget <broj>      budžet korisnika
      --interests <a,b>    interesovanja korisnika
      --json               sirov JSON izlaz

${BOLD}Okruženje${RESET}
  GOSIMPLE_EMBEDDING       local (podrazumevano) | openai
  OPENAI_API_KEY           potreban za openai embeddinge
  GOSIMPLE_TOKEN           uključuje Bearer autentikaciju na serveru
  GOSIMPLE_CORS_ORIGINS    lista dozvoljenih origin-a, razdvojena zarezima
`);
    return;
  }

  if (!args.file) {
    console.error('Nedostaje putanja do .gs fajla. Pokrenite "gs help".');
    process.exitCode = 1;
    return;
  }

  const path = resolve(args.file);
  const source = await readFile(path, 'utf8');

  switch (args.command) {
    case 'check': {
      const program = parse(source, path);
      const { plan, warnings } = compile(program, source, path);
      printWarnings(warnings, source, path);
      const rules = plan.intent?.rules.length ?? 0;
      console.log(
        `${GREEN}✓${RESET} ${BOLD}${plan.engine}${RESET} je ispravan ` +
          `${DIM}(${plan.categories.length} ${pluralKategorija(plan.categories.length)}, ` +
          `${rules} ${pluralPravilo(rules)} namere, ` +
          `${warnings.length} ${pluralUpozorenje(warnings.length)})${RESET}`,
      );
      break;
    }

    case 'plan': {
      const program = parse(source, path);
      const { plan } = compile(program, source, path);
      console.log(JSON.stringify(plan, null, 2));
      break;
    }

    case 'run': {
      if (!args.query) {
        console.error('Nedostaje upit. Koristite -q "tekst upita".');
        process.exitCode = 1;
        return;
      }
      const { plan, docs, warnings } = await loadProgram(args.file);
      if (!args.json) printWarnings(warnings, source, path);

      const engine = await Engine.create(plan, docs, { embedding: createEmbeddingProvider() });
      const request: Parameters<Engine['search']>[0] = { query: args.query };
      if (args.season) request.season = args.season;
      if (args.now) request.now = args.now;
      if (args.budget !== null || args.interests.length > 0) {
        request.user = {};
        if (args.budget !== null) request.user.budget = args.budget;
        if (args.interests.length > 0) request.user.interests = args.interests;
      }

      const result = await engine.search(request);

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      console.log(`${BOLD}Upit${RESET}    "${result.query}"`);
      console.log(`${BOLD}Sezona${RESET}  ${result.season}`);

      const intentLabel = result.intent.category
        ? `${CYAN}${result.intent.category}${RESET}` +
          (result.intent.locked ? ` ${GREEN}[zaključano]${RESET}` : ' [nije zaključano]')
        : `${YELLOW}dvosmisleno${RESET}`;
      console.log(`${BOLD}Namera${RESET}  ${intentLabel} ${DIM}(pouzdanost ${result.intent.confidence.toFixed(2)})${RESET}`);
      console.log('');

      for (const line of result.intent.trace) {
        console.log(`  ${DIM}·${RESET} ${line}`);
      }
      console.log('');

      if (result.clarify) {
        console.log(`${YELLOW}? ${result.clarify.question}${RESET}`);
        for (const option of result.clarify.options) console.log(`    - ${option}`);
        console.log('');
      }

      console.log(`${BOLD}Rezultati${RESET}`);
      result.hits.forEach((hit, index) => {
        console.log(
          `${String(index + 1).padStart(2)}. ${bar(hit.score)} ${hit.score.toFixed(3)}  ${BOLD}${hit.title}${RESET}`,
        );
        console.log(`    ${DIM}${hit.category} · ${hit.explanation ?? ''}${RESET}`);
      });

      console.log('');
      const s = result.stats;
      console.log(
        `${DIM}katalog ${s.corpusSize} · dovučeno ${s.retrieved} · odbačeno namerom ${s.filteredByIntent} · ` +
          `nedostupno ${s.filteredByAvailability} · vraćeno ${s.returned} · ${s.durationMs} ms${RESET}`,
      );
      break;
    }

    case 'recommend': {
      const { plan, docs, events, warnings } = await loadProgram(args.file);
      if (!args.json) printWarnings(warnings, source, path);

      if (!plan.recommend) {
        console.error(`Engine "${plan.engine}" nema recommend blok.`);
        process.exitCode = 1;
        return;
      }

      const recommender = new Recommender(plan, docs, events);
      const request: Parameters<Recommender['recommend']>[0] = {};
      if (args.user) request.userId = args.user;
      if (args.seed.length > 0) request.seedIds = args.seed;
      if (args.budget !== null) request.budget = args.budget;
      if (args.interests.length > 0) request.interests = args.interests;
      if (args.now) request.now = args.now;
      if (args.season) request.season = args.season;

      const result = recommender.recommend(request);

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      const strategyLabel: Record<typeof result.strategy, string> = {
        warm: `${GREEN}personalizovano${RESET} (istorija: ${result.userHistorySize} ${pluralArtikal(result.userHistorySize)})`,
        cool: `${CYAN}slično artiklu${RESET}`,
        cold: `${YELLOW}bez istorije${RESET} — popularnost i sezona`,
      };

      console.log(`${BOLD}Strategija${RESET}  ${strategyLabel[result.strategy]}`);
      console.log(`${BOLD}Sezona${RESET}      ${result.season}`);
      console.log('');

      result.items.forEach((item, index) => {
        console.log(
          `${String(index + 1).padStart(2)}. ${bar(item.score)} ${item.score.toFixed(3)}  ${BOLD}${item.title}${RESET}`,
        );
        console.log(`    ${DIM}${item.category}${RESET}`);
        for (const reason of item.reasons.slice(0, 2)) {
          console.log(`    ${DIM}· ${reason.detail}${RESET}`);
        }
      });

      console.log('');
      const s = result.stats;
      console.log(
        `${DIM}kandidata ${s.candidates} · već viđeno ${s.excludedSeen} · odbijeno ${s.excludedDismissed} · ` +
          `istraživanje ${s.exploration} · vraćeno ${s.returned} · ${s.durationMs} ms${RESET}`,
      );
      break;
    }

    case 'content': {
      const { plan, docs, warnings } = await loadProgram(args.file);
      if (!args.json) printWarnings(warnings, source, path);

      const engine = new Engine(plan, docs);
      const reports = docs.map((doc) => ({ doc, report: engine.contentFor(doc.id) }));

      if (args.json) {
        console.log(JSON.stringify(reports.map((r) => ({ id: r.doc.id, ...r.report })), null, 2));
        break;
      }

      console.log(`${BOLD}Analiza sadržaja${RESET} ${DIM}(${docs.length} dokumenata)${RESET}\n`);
      for (const { doc, report } of reports) {
        if (!report) continue;
        const t = report.templateLikeness;
        const flag = t.score >= 0.5 && t.confidence >= 0.4 ? `${YELLOW}⚠${RESET}` : ' ';
        console.log(`${flag} ${BOLD}${doc.title}${RESET}`);
        console.log(
          `    kvalitet ${bar(report.quality, 12)} ${report.quality.toFixed(2)}   ` +
            `originalnost ${bar(report.originality, 12)} ${report.originality.toFixed(2)}`,
        );
        console.log(
          `    ${DIM}šablonskost ${t.score.toFixed(2)} uz pouzdanost ${t.confidence.toFixed(2)}${RESET}`,
        );
        for (const e of t.evidence) {
          console.log(`      ${DIM}- ${e.observation}${RESET}`);
        }
        console.log('');
      }
      break;
    }

    case 'serve': {
      const { startServer } = await import('./server.ts');
      const { plan, docs, events, adapter, warnings } = await loadProgram(args.file);
      printWarnings(warnings, source, path);
      await startServer(plan, docs, args.port, adapter, events);
      break;
    }

    default:
      console.error(`Nepoznata komanda "${args.command}". Pokrenite "gs help".`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof GoSimpleError) {
    console.error(formatDiagnostics(err.diagnostics, err.source, err.file));
    const errorCount = err.diagnostics.filter((d) => d.severity === 'error').length;
    console.error(`\n${errorCount} ${pluralGreska(errorCount)}.`);
  } else {
    console.error(`${(err as Error).message}`);
  }
  process.exitCode = 1;
});
