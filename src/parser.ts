/**
 * GoSimple recursive-descent parser.
 *
 * The grammar is deliberately small and block-structured. Every construct is
 * `keyword name { clauses }`, which keeps parsing predictable and makes error
 * recovery at block boundaries straightforward.
 */

import { tokenize, LexError, type Token } from './lexer.ts';
import { SEASONS, type CategoryDecl, type ColumnMap, type ContentBlock, type Decl, type EngineDecl, type FactorClause, type IntentDecl, type IntentRule, type MatchClause, type Program, type RankClause, type RecommendBlock, type SearchBlock, type Season, type SourceDecl, type Span, type TaxonomyDecl } from './ast.ts';
import { GoSimpleError, suggest, type Diagnostic } from './diagnostics.ts';

const TOP_LEVEL = ['source', 'events', 'taxonomy', 'intent', 'engine'] as const;

class Parser {
  private tokens: Token[];
  private pos = 0;
  private diagnostics: Diagnostic[] = [];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.pos + ahead, this.tokens.length - 1)]!;
  }

  private spanOf(token: Token): Span {
    return { line: token.line, col: token.col };
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== 'eof') this.pos++;
    return token;
  }

  private fail(message: string, token: Token, hint?: string): never {
    const diagnostic: Diagnostic = {
      severity: 'error',
      code: 'GS1001',
      message,
      span: this.spanOf(token),
    };
    if (hint) diagnostic.hint = hint;
    this.diagnostics.push(diagnostic);
    throw new ParseAbort();
  }

  private expect(kind: Token['kind'], what: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      this.fail(`Očekivano ${what}, pronađeno "${token.text || token.kind}"`, token);
    }
    return this.advance();
  }

  /** Consumes an identifier, optionally requiring a specific word. */
  private expectWord(word?: string): Token {
    const token = this.peek();
    if (token.kind !== 'ident') {
      this.fail(`Očekivana reč${word ? ` "${word}"` : ''}, pronađeno "${token.text || token.kind}"`, token);
    }
    if (word !== undefined && token.text !== word) {
      this.fail(`Očekivano "${word}", pronađeno "${token.text}"`, token);
    }
    return this.advance();
  }

  private atWord(word: string, ahead = 0): boolean {
    const token = this.peek(ahead);
    return token.kind === 'ident' && token.text === word;
  }

  private eatWord(word: string): boolean {
    if (this.atWord(word)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expectString(what: string): { value: string; token: Token } {
    const token = this.expect('string', what);
    return { value: token.value as string, token };
  }

  private expectNumber(what: string): { value: number; token: Token } {
    const token = this.expect('number', what);
    return { value: token.value as number, token };
  }

  /** Parses `[a, b, c]` or `["a", "b"]`; bare identifiers and strings both allowed. */
  private parseList(what: string): string[] {
    this.expect('[', `"[" za listu ${what}`);
    const items: string[] = [];
    while (this.peek().kind !== ']') {
      const token = this.peek();
      if (token.kind === 'string') {
        items.push(this.advance().value as string);
      } else if (token.kind === 'ident') {
        items.push(this.advance().text);
      } else {
        this.fail(`Očekivan element liste ${what}, pronađeno "${token.text || token.kind}"`, token);
      }
      if (!this.eat(',')) break;
    }
    this.expect(']', `"]" na kraju liste ${what}`);
    return items;
  }

  private eat(kind: Token['kind']): boolean {
    if (this.peek().kind === kind) {
      this.advance();
      return true;
    }
    return false;
  }

  parseProgram(): { program: Program; diagnostics: Diagnostic[] } {
    const decls: Decl[] = [];

    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind !== 'ident') {
        this.fail(
          `Očekivana deklaracija najvišeg nivoa, pronađeno "${token.text || token.kind}"`,
          token,
          `Dozvoljeno je: ${TOP_LEVEL.join(', ')}.`,
        );
      }
      switch (token.text) {
        case 'source':
          decls.push(this.parseSource());
          break;
        case 'events': {
          const start = this.expectWord('events');
          this.expectWord('from');
          const { value: uri } = this.expectString('putanja do događaja u navodnicima');
          decls.push({ kind: 'events', uri, span: this.spanOf(start) });
          break;
        }
        case 'taxonomy':
          decls.push(this.parseTaxonomy());
          break;
        case 'intent':
          decls.push(this.parseIntent());
          break;
        case 'engine':
          decls.push(this.parseEngine());
          break;
        default: {
          const hint = suggest(token.text, TOP_LEVEL);
          this.fail(
            `Nepoznata deklaracija "${token.text}"`,
            token,
            hint ? `Da li ste mislili "${hint}"?` : `Dozvoljeno je: ${TOP_LEVEL.join(', ')}.`,
          );
        }
      }
    }

    return { program: { kind: 'program', decls }, diagnostics: this.diagnostics };
  }

  // source products from "catalog.json"
  // source products from "postgres://..." { table "products" map { id "id" ... } }
  private parseSource(): SourceDecl {
    const start = this.expectWord('source');
    const name = this.expectWord().text;
    this.expectWord('from');
    const { value: uri } = this.expectString('URI izvora u navodnicima');

    let table: string | null = null;
    let where: string | null = null;
    let limit: number | null = null;
    const columns: ColumnMap = {};

    if (this.peek().kind === '{') {
      this.advance();
      while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
        if (this.eatWord('table')) {
          table = this.expectString('naziv tabele u navodnicima').value;
          continue;
        }
        if (this.eatWord('where')) {
          where = this.expectString('SQL uslov u navodnicima').value;
          continue;
        }
        if (this.eatWord('limit')) {
          limit = this.expectNumber('maksimalan broj redova').value;
          continue;
        }
        if (this.atWord('map')) {
          this.advance();
          this.expect('{', '"{" posle map');
          while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
            const field = this.expectWord().text;
            this.eat(':');
            columns[field] = this.expectString(`naziv kolone za polje "${field}"`).value;
            this.eat(',');
          }
          this.expect('}', '"}" na kraju map bloka');
          continue;
        }

        const token = this.peek();
        const hint = suggest(token.text, ['table', 'map', 'where', 'limit']);
        this.fail(
          `Nepoznata opcija izvora: "${token.text || token.kind}"`,
          token,
          hint ? `Da li ste mislili "${hint}"?` : 'Dozvoljeno: table, map, where, limit.',
        );
      }
      this.expect('}', `"}" na kraju izvora "${name}"`);
    }

    return { kind: 'source', name, uri, table, columns, where, limit, span: this.spanOf(start) };
  }

  // taxonomy { category "ime" { terms [...] signals [...] season [...] } }
  private parseTaxonomy(): TaxonomyDecl {
    const start = this.expectWord('taxonomy');
    this.expect('{', '"{" posle taxonomy');

    const categories: CategoryDecl[] = [];
    while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
      categories.push(this.parseCategory());
    }
    this.expect('}', '"}" na kraju taxonomy bloka');
    return { kind: 'taxonomy', categories, span: this.spanOf(start) };
  }

  private parseCategory(): CategoryDecl {
    const start = this.expectWord('category');
    const { value: name } = this.expectString('naziv kategorije u navodnicima');
    this.expect('{', `"{" posle naziva kategorije "${name}"`);

    let terms: string[] = [];
    let signals: string[] = [];
    let seasons: Season[] = [];

    while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
      const key = this.peek();
      if (key.kind !== 'ident') {
        this.fail(`Očekivano svojstvo kategorije, pronađeno "${key.text || key.kind}"`, key);
      }
      this.advance();
      this.eat(':'); // optional colon, both `terms [...]` and `terms: [...]` parse

      switch (key.text) {
        case 'terms':
          terms = this.parseList('terms');
          break;
        case 'signals':
          signals = this.parseList('signals');
          break;
        case 'season':
        case 'seasons': {
          const raw = this.parseList('season');
          for (const value of raw) {
            if (!(SEASONS as string[]).includes(value)) {
              const hint = suggest(value, SEASONS);
              this.fail(
                `Nepoznato godišnje doba "${value}"`,
                key,
                hint ? `Da li ste mislili "${hint}"?` : `Dozvoljeno: ${SEASONS.join(', ')}.`,
              );
            }
            seasons.push(value as Season);
          }
          break;
        }
        default: {
          const hint = suggest(key.text, ['terms', 'signals', 'season']);
          this.fail(
            `Nepoznato svojstvo kategorije "${key.text}"`,
            key,
            hint ? `Da li ste mislili "${hint}"?` : 'Dozvoljeno: terms, signals, season.',
          );
        }
      }
    }

    this.expect('}', `"}" na kraju kategorije "${name}"`);
    return { kind: 'category', name, terms, signals, seasons, span: this.spanOf(start) };
  }

  // intent Discovery { detect from query, context  rule "..." {...}  fallback ambiguous when confidence < 0.6 }
  private parseIntent(): IntentDecl {
    const start = this.expectWord('intent');
    const name = this.expectWord().text;
    this.expect('{', `"{" posle intent "${name}"`);

    const rules: IntentRule[] = [];
    let ambiguousBelow = 0.5;

    while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
      if (this.atWord('detect')) {
        // `detect from query, context` is declarative documentation in v0.1:
        // the runtime always has query + context available.
        this.advance();
        this.expectWord('from');
        do {
          this.expectWord();
        } while (this.eat(','));
        continue;
      }

      if (this.atWord('rule')) {
        rules.push(this.parseIntentRule());
        continue;
      }

      if (this.atWord('fallback')) {
        this.advance();
        this.expectWord('ambiguous');
        this.expectWord('when');
        this.expectWord('confidence');
        this.expect('<', '"<" u fallback pragu');
        ambiguousBelow = this.expectNumber('prag pouzdanosti').value;
        continue;
      }

      const token = this.peek();
      const hint = suggest(token.text, ['detect', 'rule', 'fallback']);
      this.fail(
        `Nepoznata naredba u intent bloku: "${token.text || token.kind}"`,
        token,
        hint ? `Da li ste mislili "${hint}"?` : 'Dozvoljeno: detect, rule, fallback.',
      );
    }

    this.expect('}', `"}" na kraju intent "${name}"`);
    return { kind: 'intent', name, rules, ambiguousBelow, span: this.spanOf(start) };
  }

  // rule "auto" { when signal of "auto-delovi" then category "auto-delovi" confidence 0.95 lock }
  private parseIntentRule(): IntentRule {
    const start = this.expectWord('rule');
    const { value: name } = this.expectString('naziv pravila u navodnicima');
    this.expect('{', `"{" posle pravila "${name}"`);

    this.expectWord('when');
    this.expectWord('signal');
    this.expectWord('of');
    const { value: whenSignalOf } = this.expectString('naziv kategorije u navodnicima');

    this.expectWord('then');
    this.expectWord('category');
    const { value: thenCategory } = this.expectString('naziv kategorije u navodnicima');

    let confidence = 0.9;
    let lock = false;

    while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
      if (this.eatWord('confidence')) {
        confidence = this.expectNumber('vrednost pouzdanosti').value;
        continue;
      }
      if (this.eatWord('lock')) {
        lock = true;
        continue;
      }
      const token = this.peek();
      const hint = suggest(token.text, ['confidence', 'lock']);
      this.fail(
        `Nepoznata opcija pravila: "${token.text || token.kind}"`,
        token,
        hint ? `Da li ste mislili "${hint}"?` : 'Dozvoljeno: confidence, lock.',
      );
    }

    this.expect('}', `"}" na kraju pravila "${name}"`);
    return { name, whenSignalOf, thenCategory, confidence, lock, span: this.spanOf(start) };
  }

  private parseEngine(): EngineDecl {
    const start = this.expectWord('engine');
    const name = this.expectWord().text;
    this.expect('{', `"{" posle engine "${name}"`);

    let useSource: string | null = null;
    let useIntent: string | null = null;
    let search: SearchBlock | null = null;
    let recommend: RecommendBlock | null = null;
    let content: ContentBlock | null = null;

    while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
      if (this.atWord('use')) {
        this.advance();
        if (this.eatWord('source')) {
          useSource = this.expectWord().text;
        } else if (this.eatWord('intent')) {
          useIntent = this.expectWord().text;
        } else {
          this.fail('Posle "use" očekivano "source" ili "intent"', this.peek());
        }
        continue;
      }
      if (this.atWord('search')) {
        search = this.parseSearch();
        continue;
      }
      if (this.atWord('recommend')) {
        recommend = this.parseRecommend();
        continue;
      }
      if (this.atWord('content')) {
        content = this.parseContent();
        continue;
      }

      const token = this.peek();
      const hint = suggest(token.text, ['use', 'search', 'recommend', 'content']);
      this.fail(
        `Nepoznat blok u engine "${name}": "${token.text || token.kind}"`,
        token,
        hint ? `Da li ste mislili "${hint}"?` : 'Dozvoljeno: use, search, recommend, content.',
      );
    }

    this.expect('}', `"}" na kraju engine "${name}"`);
    return { kind: 'engine', name, useSource, useIntent, search, recommend, content, span: this.spanOf(start) };
  }

  private parseSearch(): SearchBlock {
    const start = this.expectWord('search');
    this.expect('{', '"{" posle search');

    let retrieve = 200;
    const match: MatchClause[] = [];
    const rank: RankClause[] = [];
    let protectIntent = false;
    let diversify: { field: string; max: number } | null = null;
    let excludeUnavailable = false;
    let explain = false;
    let topN = 10;

    while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
      if (this.eatWord('retrieve')) {
        retrieve = this.expectNumber('broj kandidata').value;
        this.eatWord('candidates');
        continue;
      }
      if (this.atWord('match')) {
        this.advance();
        this.expect('{', '"{" posle match');
        while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
          const field = this.expectWord();
          this.eatWord('weight');
          const weight = this.expectNumber(`težina za "${field.text}"`);
          match.push({ field: field.text, weight: weight.value, span: this.spanOf(field) });
          this.eat(',');
        }
        this.expect('}', '"}" na kraju match bloka');
        continue;
      }
      if (this.atWord('rank')) {
        this.advance();
        this.expectWord('by');
        this.expect('{', '"{" posle rank by');
        while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
          const signal = this.expectWord();
          this.eatWord('weight');
          const weight = this.expectNumber(`težina za "${signal.text}"`);
          rank.push({ signal: signal.text, weight: weight.value, span: this.spanOf(signal) });
          this.eat(',');
        }
        this.expect('}', '"}" na kraju rank bloka');
        continue;
      }
      if (this.atWord('protect')) {
        this.advance();
        this.expectWord('intent');
        protectIntent = true;
        continue;
      }
      if (this.atWord('diversify')) {
        this.advance();
        this.expectWord('by');
        const field = this.expectWord().text;
        let max = 3;
        if (this.eatWord('max')) max = this.expectNumber('maksimum po grupi').value;
        diversify = { field, max };
        continue;
      }
      if (this.atWord('exclude')) {
        this.advance();
        this.expectWord('unavailable');
        excludeUnavailable = true;
        continue;
      }
      if (this.atWord('explain')) {
        this.advance();
        this.eatWord('every');
        this.eatWord('result');
        explain = true;
        continue;
      }
      if (this.atWord('return')) {
        this.advance();
        this.expectWord('top');
        topN = this.expectNumber('broj rezultata').value;
        continue;
      }

      const token = this.peek();
      const hint = suggest(token.text, ['retrieve', 'match', 'rank', 'protect', 'diversify', 'exclude', 'explain', 'return']);
      this.fail(
        `Nepoznata naredba u search bloku: "${token.text || token.kind}"`,
        token,
        hint ? `Da li ste mislili "${hint}"?` : undefined,
      );
    }

    this.expect('}', '"}" na kraju search bloka');
    return {
      kind: 'search',
      retrieve,
      match,
      rank,
      protectIntent,
      diversify,
      excludeUnavailable,
      explain,
      topN,
      span: this.spanOf(start),
    };
  }

  private parseRecommend(): RecommendBlock {
    const start = this.expectWord('recommend');
    this.expect('{', '"{" posle recommend');

    let learnFrom: string[] = [];
    let accountFor: string[] = [];
    const factors: FactorClause[] = [];
    let explore: number | null = null;
    let excludeRecentlySeen = false;
    let topN = 12;

    while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
      if (this.atWord('learn')) {
        this.advance();
        this.expectWord('from');
        this.eat(':');
        learnFrom = this.parseList('learn from');
        continue;
      }
      if (this.atWord('account')) {
        this.advance();
        this.expectWord('for');
        this.eat(':');
        accountFor = this.parseList('account for');
        continue;
      }
      if (this.atWord('factors')) {
        this.advance();
        this.expect('{', '"{" posle factors');
        while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
          const nameToken = this.expectWord();
          this.eatWord('weight');
          this.eat(':');
          const weight = this.expectNumber(`težina faktora "${nameToken.text}"`);
          factors.push({ factor: nameToken.text, weight: weight.value, span: this.spanOf(nameToken) });
        }
        this.expect('}', '"}" na kraju factors bloka');
        continue;
      }
      if (this.atWord('explore')) {
        this.advance();
        this.eat(':');
        explore = this.expectNumber('udeo istraživanja').value;
        continue;
      }
      if (this.atWord('exclude')) {
        this.advance();
        this.expectWord('recently_seen');
        excludeRecentlySeen = true;
        continue;
      }
      if (this.atWord('return')) {
        this.advance();
        this.expectWord('top');
        topN = this.expectNumber('broj rezultata').value;
        continue;
      }

      const token = this.peek();
      const hint = suggest(token.text, ['learn', 'account', 'factors', 'explore', 'exclude', 'return']);
      this.fail(
        `Nepoznata naredba u recommend bloku: "${token.text || token.kind}"`,
        token,
        hint ? `Da li ste mislili "${hint}"?` : undefined,
      );
    }

    this.expect('}', '"}" na kraju recommend bloka');
    return {
      kind: 'recommend',
      learnFrom,
      accountFor,
      factors,
      explore,
      excludeRecentlySeen,
      topN,
      span: this.spanOf(start),
    };
  }

  private parseContent(): ContentBlock {
    const start = this.expectWord('content');
    this.expect('{', '"{" posle content');

    let analyze: string[] = [];
    const scores: string[] = [];

    while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
      if (this.atWord('analyze')) {
        this.advance();
        this.eat(':');
        analyze = this.parseList('analyze');
        continue;
      }
      if (this.atWord('score')) {
        this.advance();
        scores.push(this.expectWord().text);
        continue;
      }

      const token = this.peek();
      const hint = suggest(token.text, ['analyze', 'score']);
      this.fail(
        `Nepoznata naredba u content bloku: "${token.text || token.kind}"`,
        token,
        hint ? `Da li ste mislili "${hint}"?` : undefined,
      );
    }

    this.expect('}', '"}" na kraju content bloka');
    return { kind: 'content', analyze, scores, span: this.spanOf(start) };
  }
}

class ParseAbort extends Error {}

export function parse(source: string, file = '<memory>'): Program {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (err) {
    if (err instanceof LexError) {
      throw new GoSimpleError(
        [{ severity: 'error', code: 'GS1000', message: err.message, span: { line: err.line, col: err.col } }],
        source,
        file,
      );
    }
    throw err;
  }

  const parser = new Parser(tokens);
  try {
    const { program, diagnostics } = parser.parseProgram();
    if (diagnostics.some((d) => d.severity === 'error')) {
      throw new GoSimpleError(diagnostics, source, file);
    }
    return program;
  } catch (err) {
    if (err instanceof ParseAbort) {
      throw new GoSimpleError(parser['diagnostics'], source, file);
    }
    throw err;
  }
}
