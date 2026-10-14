/**
 * Parser and SQL builder for the `where` clause of a SQL source.
 *
 * This exists because the obvious approach does not work. Rejecting `;`,
 * `--` and comment markers looks like a filter but is a blocklist, and a
 * blocklist on SQL fails to the first input nobody thought of:
 *
 *     where "false UNION SELECT username, password_hash, 0::text FROM users"
 *
 * contains none of the forbidden characters, concatenates cleanly into the
 * SELECT, and returns another table's contents as if they were products.
 * That was not a hypothetical — it was reproduced against a live database.
 *
 * So the string is never concatenated. It is parsed into a small expression
 * tree that can only express row filtering, and the SQL is rebuilt from that
 * tree: identifiers are validated and quoted, and every literal leaves as a
 * bound parameter. Anything the grammar cannot represent — subqueries, set
 * operations, function calls, casts — is a compile error with a position,
 * not a runtime surprise.
 */

export type WhereLiteral = string | number | boolean;

export type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>=' | 'LIKE' | 'NOT LIKE' | 'ILIKE';

export type WhereExpr =
  | { kind: 'and'; left: WhereExpr; right: WhereExpr }
  | { kind: 'or'; left: WhereExpr; right: WhereExpr }
  | { kind: 'not'; operand: WhereExpr }
  | { kind: 'compare'; column: string; op: CompareOp; value: WhereLiteral }
  | { kind: 'isNull'; column: string; negated: boolean }
  | { kind: 'in'; column: string; values: WhereLiteral[]; negated: boolean }
  | { kind: 'bool'; value: boolean };

export class WhereParseError extends Error {
  /** Zero-based offset into the where string, for caret placement. */
  readonly offset: number;
  readonly hint: string | undefined;

  constructor(message: string, offset: number, hint?: string) {
    super(message);
    this.name = 'WhereParseError';
    this.offset = offset;
    this.hint = hint;
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reserved words the grammar understands. Everything else is an identifier. */
const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'IS', 'NULL', 'TRUE', 'FALSE', 'IN', 'LIKE', 'ILIKE']);

type Tok =
  | { kind: 'ident'; text: string; offset: number }
  | { kind: 'keyword'; text: string; offset: number }
  | { kind: 'string'; value: string; offset: number }
  | { kind: 'number'; value: number; offset: number }
  | { kind: 'op'; text: string; offset: number }
  | { kind: 'eof'; offset: number };

function lex(input: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Comment markers are not part of the grammar. Naming them explicitly
    // produces a better message than "unexpected character".
    if (ch === '-' && input[i + 1] === '-') {
      throw new WhereParseError('Komentari nisu dozvoljeni u where uslovu', i);
    }
    if (ch === '/' && input[i + 1] === '*') {
      throw new WhereParseError('Komentari nisu dozvoljeni u where uslovu', i);
    }
    if (ch === ';') {
      throw new WhereParseError('Where uslov ne sme da sadrži kraj naredbe', i);
    }

    if (ch === "'") {
      const start = i;
      i++;
      let value = '';
      let closed = false;
      while (i < input.length) {
        if (input[i] === "'") {
          if (input[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += input[i];
        i++;
      }
      if (!closed) throw new WhereParseError('Nezatvoren tekstualni literal', start);
      tokens.push({ kind: 'string', value, offset: start });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < input.length && /[0-9.]/.test(input[i]!)) i++;
      const text = input.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new WhereParseError(`Neispravan broj "${text}"`, start);
      tokens.push({ kind: 'number', value, offset: start });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i]!)) i++;
      const text = input.slice(start, i);
      const upper = text.toUpperCase();
      tokens.push(
        KEYWORDS.has(upper)
          ? { kind: 'keyword', text: upper, offset: start }
          : { kind: 'ident', text, offset: start },
      );
      continue;
    }

    const two = input.slice(i, i + 2);
    if (two === '<>' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ kind: 'op', text: two === '!=' ? '<>' : two, offset: i });
      i += 2;
      continue;
    }

    if ('=<>(),'.includes(ch)) {
      tokens.push({ kind: 'op', text: ch, offset: i });
      i++;
      continue;
    }

    throw new WhereParseError(
      `Znak "${ch}" nije dozvoljen u where uslovu`,
      i,
      'Dozvoljena su poređenja kolona sa literalima, povezana sa AND, OR i NOT.',
    );
  }

  tokens.push({ kind: 'eof', offset: input.length });
  return tokens;
}

class WhereParser {
  private tokens: Tok[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = lex(input);
  }

  private peek(): Tok {
    return this.tokens[this.pos]!;
  }

  private next(): Tok {
    const token = this.peek();
    if (token.kind !== 'eof') this.pos++;
    return token;
  }

  private eatKeyword(word: string): boolean {
    const token = this.peek();
    if (token.kind === 'keyword' && token.text === word) {
      this.pos++;
      return true;
    }
    return false;
  }

  private eatOp(text: string): boolean {
    const token = this.peek();
    if (token.kind === 'op' && token.text === text) {
      this.pos++;
      return true;
    }
    return false;
  }

  private describe(token: Tok): string {
    switch (token.kind) {
      case 'eof':
        return 'kraj uslova';
      case 'string':
        return `tekst '${token.value}'`;
      case 'number':
        return `broj ${token.value}`;
      default:
        return `"${token.text}"`;
    }
  }

  parse(): WhereExpr {
    const expr = this.parseOr();
    const trailing = this.peek();
    if (trailing.kind !== 'eof') {
      throw new WhereParseError(
        `Neočekivano ${this.describe(trailing)} posle kraja uslova`,
        trailing.offset,
        trailing.kind === 'keyword' || trailing.kind === 'ident'
          ? 'Podupiti i skupovne operacije (UNION, SELECT) nisu dozvoljeni — where sme samo da filtrira redove.'
          : undefined,
      );
    }
    return expr;
  }

  private parseOr(): WhereExpr {
    let left = this.parseAnd();
    while (this.eatKeyword('OR')) {
      left = { kind: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): WhereExpr {
    let left = this.parseNot();
    while (this.eatKeyword('AND')) {
      left = { kind: 'and', left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): WhereExpr {
    if (this.eatKeyword('NOT')) return { kind: 'not', operand: this.parseNot() };
    return this.parsePrimary();
  }

  private parsePrimary(): WhereExpr {
    if (this.eatOp('(')) {
      const inner = this.parseOr();
      if (!this.eatOp(')')) {
        const token = this.peek();
        throw new WhereParseError(`Očekivana ")" , nađeno ${this.describe(token)}`, token.offset);
      }
      return inner;
    }

    const token = this.peek();

    if (token.kind === 'keyword' && (token.text === 'TRUE' || token.text === 'FALSE')) {
      this.next();
      return { kind: 'bool', value: token.text === 'TRUE' };
    }

    if (token.kind !== 'ident') {
      throw new WhereParseError(
        `Očekivano ime kolone, nađeno ${this.describe(token)}`,
        token.offset,
        'Where uslov počinje imenom kolone, na primer `deleted_at IS NULL`.',
      );
    }

    this.next();
    const column = token.text;

    // A column followed by "(" is a function call, which the grammar does
    // not allow. Saying so beats a generic parse error.
    if (this.peek().kind === 'op' && (this.peek() as { text: string }).text === '(') {
      throw new WhereParseError(
        `Pozivi funkcija nisu dozvoljeni u where uslovu ("${column}")`,
        token.offset,
        'Where sme da poredi kolone sa literalima; izračunavanja pripadaju pogledu u bazi.',
      );
    }

    if (this.eatKeyword('IS')) {
      const negated = this.eatKeyword('NOT');
      if (!this.eatKeyword('NULL')) {
        const bad = this.peek();
        throw new WhereParseError(`Posle IS se očekuje NULL, nađeno ${this.describe(bad)}`, bad.offset);
      }
      return { kind: 'isNull', column, negated };
    }

    let negated = this.eatKeyword('NOT');

    if (this.eatKeyword('IN')) {
      if (!this.eatOp('(')) {
        const bad = this.peek();
        throw new WhereParseError(`Posle IN se očekuje "(", nađeno ${this.describe(bad)}`, bad.offset);
      }
      const values: WhereLiteral[] = [this.parseLiteral()];
      while (this.eatOp(',')) values.push(this.parseLiteral());
      if (!this.eatOp(')')) {
        const bad = this.peek();
        throw new WhereParseError(`Očekivana ")" na kraju IN liste, nađeno ${this.describe(bad)}`, bad.offset);
      }
      return { kind: 'in', column, values, negated };
    }

    if (this.eatKeyword('LIKE')) {
      return { kind: 'compare', column, op: negated ? 'NOT LIKE' : 'LIKE', value: this.parseLiteral() };
    }

    if (this.eatKeyword('ILIKE')) {
      if (negated) {
        throw new WhereParseError('NOT ILIKE nije podržan', token.offset, 'Koristite `NOT (kolona ILIKE ...)`.');
      }
      return { kind: 'compare', column, op: 'ILIKE', value: this.parseLiteral() };
    }

    if (negated) {
      const bad = this.peek();
      throw new WhereParseError(`Posle NOT se očekuje IN ili LIKE, nađeno ${this.describe(bad)}`, bad.offset);
    }
    negated = false;

    const opToken = this.peek();
    if (opToken.kind === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(opToken.text)) {
      this.next();
      return { kind: 'compare', column, op: opToken.text as CompareOp, value: this.parseLiteral() };
    }

    throw new WhereParseError(
      `Očekivan operator poređenja posle "${column}", nađeno ${this.describe(opToken)}`,
      opToken.offset,
      'Dozvoljeno: = <> < <= > >=, IS [NOT] NULL, [NOT] IN (...), [NOT] LIKE, ILIKE.',
    );
  }

  private parseLiteral(): WhereLiteral {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return token.value;
    if (token.kind === 'keyword' && token.text === 'TRUE') return true;
    if (token.kind === 'keyword' && token.text === 'FALSE') return false;

    throw new WhereParseError(
      `Očekivan literal, nađeno ${this.describe(token)}`,
      token.offset,
      token.kind === 'ident'
        ? 'Poređenje dve kolone nije dozvoljeno; desna strana mora biti tekst, broj ili TRUE/FALSE.'
        : undefined,
    );
  }
}

/** Parses a where clause, or throws WhereParseError with an offset. */
export function parseWhere(input: string): WhereExpr {
  const trimmed = input.trim();
  if (trimmed === '') throw new WhereParseError('Where uslov je prazan', 0);
  return new WhereParser(trimmed).parse();
}

/** Every column the expression reads, so the compiler can report them. */
export function columnsOf(expr: WhereExpr): string[] {
  const found = new Set<string>();
  const walk = (node: WhereExpr): void => {
    switch (node.kind) {
      case 'and':
      case 'or':
        walk(node.left);
        walk(node.right);
        break;
      case 'not':
        walk(node.operand);
        break;
      case 'compare':
      case 'isNull':
      case 'in':
        found.add(node.column);
        break;
      case 'bool':
        break;
    }
  };
  walk(expr);
  return [...found].sort();
}

/**
 * Renders the expression as SQL.
 *
 * Literals are never written into the string. Each one is appended to
 * `params` and referenced as `$n`, so the database receives values as data
 * and there is no parse step in which they could become syntax.
 */
export function toSql(expr: WhereExpr, params: unknown[]): string {
  const quote = (column: string): string => {
    // Already enforced by the lexer, but this function is the last thing
    // between the expression tree and the database, so it checks again.
    if (!IDENTIFIER.test(column)) {
      throw new WhereParseError(`Nedozvoljeno ime kolone "${column}"`, 0);
    }
    return `"${column}"`;
  };

  const bind = (value: WhereLiteral): string => {
    params.push(value);
    return `$${params.length}`;
  };

  switch (expr.kind) {
    case 'and':
      return `(${toSql(expr.left, params)} AND ${toSql(expr.right, params)})`;
    case 'or':
      return `(${toSql(expr.left, params)} OR ${toSql(expr.right, params)})`;
    case 'not':
      return `(NOT ${toSql(expr.operand, params)})`;
    case 'bool':
      return expr.value ? 'TRUE' : 'FALSE';
    case 'isNull':
      return `${quote(expr.column)} IS ${expr.negated ? 'NOT ' : ''}NULL`;
    case 'in': {
      const placeholders = expr.values.map(bind).join(', ');
      return `${quote(expr.column)} ${expr.negated ? 'NOT ' : ''}IN (${placeholders})`;
    }
    case 'compare':
      return `${quote(expr.column)} ${expr.op} ${bind(expr.value)}`;
  }
}
