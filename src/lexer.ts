/**
 * GoSimple lexer.
 *
 * Produces a flat token stream. Keywords are not reserved at this stage: the
 * parser decides from position whether an identifier acts as a keyword. This
 * keeps user-chosen names (category names, field names) from colliding with
 * language vocabulary as the language grows.
 */

export type TokenKind =
  | 'ident'
  | 'string'
  | 'number'
  | 'bool'
  | '{'
  | '}'
  | '['
  | ']'
  | ','
  | ':'
  | '<'
  | '>'
  | '<='
  | '>='
  | '='
  | 'eof';

export type Token = {
  kind: TokenKind;
  /** Raw source text, for identifiers and punctuation. */
  text: string;
  /** Decoded value for string/number/bool literals. */
  value?: string | number | boolean;
  line: number;
  col: number;
  offset: number;
};

export class LexError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(message);
    this.name = 'LexError';
    this.line = line;
    this.col = col;
  }
}

const PUNCT_2 = new Set(['<=', '>=']);
const PUNCT_1 = new Set(['{', '}', '[', ']', ',', ':', '<', '>', '=']);

/** Identifiers allow unicode letters so Serbian words work unescaped. */
function isIdentStart(ch: string): boolean {
  return /\p{L}|_/u.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /\p{L}|\p{N}|[_.\-]/u.test(ch);
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const col = () => i - lineStart + 1;

  const push = (kind: TokenKind, text: string, startCol: number, startOffset: number, value?: string | number | boolean) => {
    const token: Token = { kind, text, line, col: startCol, offset: startOffset };
    if (value !== undefined) token.value = value;
    tokens.push(token);
  };

  while (i < source.length) {
    const ch = source[i]!;

    // Newlines and whitespace are insignificant.
    if (ch === '\n') {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    // Comments: `#` and `//` run to end of line.
    if (ch === '#' || (ch === '/' && source[i + 1] === '/')) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    const startCol = col();
    const startOffset = i;

    // String literal.
    if (ch === '"') {
      i++;
      let out = '';
      while (true) {
        if (i >= source.length || source[i] === '\n') {
          throw new LexError('Nezatvoren string literal', line, startCol);
        }
        const c = source[i]!;
        if (c === '"') {
          i++;
          break;
        }
        if (c === '\\') {
          const next = source[i + 1];
          if (next === undefined) throw new LexError('Nezatvoren escape u stringu', line, col());
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
          const decoded = map[next];
          if (decoded === undefined) {
            throw new LexError(`Nepoznat escape "\\${next}"`, line, col());
          }
          out += decoded;
          i += 2;
          continue;
        }
        out += c;
        i++;
      }
      push('string', source.slice(startOffset, i), startCol, startOffset, out);
      continue;
    }

    // Number literal (integers and decimals, no exponents in v0.1).
    if (/[0-9]/.test(ch)) {
      while (i < source.length && /[0-9]/.test(source[i]!)) i++;
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        i++;
        while (i < source.length && /[0-9]/.test(source[i]!)) i++;
      }
      const raw = source.slice(startOffset, i);
      push('number', raw, startCol, startOffset, Number(raw));
      continue;
    }

    // Two-char punctuation before one-char, so `<=` wins over `<`.
    const two = source.slice(i, i + 2);
    if (PUNCT_2.has(two)) {
      i += 2;
      push(two as TokenKind, two, startCol, startOffset);
      continue;
    }
    if (PUNCT_1.has(ch)) {
      i++;
      push(ch as TokenKind, ch, startCol, startOffset);
      continue;
    }

    // Identifier / keyword / boolean.
    if (isIdentStart(ch)) {
      i++;
      while (i < source.length && isIdentPart(source[i]!)) i++;
      const raw = source.slice(startOffset, i);
      if (raw === 'true' || raw === 'false') {
        push('bool', raw, startCol, startOffset, raw === 'true');
      } else {
        push('ident', raw, startCol, startOffset);
      }
      continue;
    }

    throw new LexError(`Neočekivan znak "${ch}"`, line, startCol);
  }

  tokens.push({ kind: 'eof', text: '', line, col: col(), offset: i });
  return tokens;
}
