const ANSI_C_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

const ZERO_WIDTH_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/g;
const IFS_EXPANSIONS = /\$\{IFS[^}]*\}|\$IFS\b/g;

function readAnsiCQuoted(source: string, openIndex: number): { value: string; end: number } | undefined {
  if (source[openIndex] !== '$' || source[openIndex + 1] !== "'") return undefined;
  let index = openIndex + 2;
  let value = '';
  while (index < source.length) {
    const character = source[index];
    if (character === "'") return { value, end: index + 1 };
    if (character !== '\\') {
      value += character;
      index += 1;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped === undefined) return undefined;
    const namedEscape = ANSI_C_ESCAPES[escaped];
    if (namedEscape !== undefined) {
      value += namedEscape;
      index += 2;
      continue;
    }
    const encoded = escaped === 'x'
      ? source.slice(index + 2).match(/^[0-9a-fA-F]{1,2}/)?.[0]
      : escaped === 'u'
        ? source.slice(index + 2).match(/^[0-9a-fA-F]{1,4}/)?.[0]
        : escaped === 'U'
          ? source.slice(index + 2).match(/^[0-9a-fA-F]{1,8}/)?.[0]
          : source.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    const isUnicodeEscape = escaped === 'u' || escaped === 'U';
    const radix = escaped === 'x' || isUnicodeEscape ? 16 : 8;
    if (encoded !== undefined) {
      const parsed = Number.parseInt(encoded, radix);
      if (!isUnicodeEscape || parsed <= 0x10ffff) {
        value += isUnicodeEscape ? String.fromCodePoint(parsed) : String.fromCharCode(parsed);
        index += encoded.length + (radix === 16 ? 2 : 1);
        continue;
      }
    }
    value += escaped;
    index += 2;
  }
  return undefined;
}

function expandWhitespaceOnlyAnsiCQuotes(command: string): string {
  let result = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      result += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      result += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += character;
      continue;
    }
    if (character === '$' && command[index + 1] === "'") {
      const decoded = readAnsiCQuoted(command, index);
      if (decoded && /^\s+$/.test(decoded.value)) {
        result += ' ';
        index = decoded.end - 1;
        continue;
      }
    }
    result += character;
  }
  return result;
}

/**
 * Quote-preserving prefix used by write-target scanning: NFKC, strip zero-width
 * characters, expand `$IFS` / `${IFS…}` to a space, and expand unquoted ANSI-C
 * quotes whose decoded value is only whitespace (`$'\x20'`, `$'\t'`). Regular
 * quotes are left in place so `"my file.txt"` stays one word.
 */
export function normalizeShellText(command: string): string {
  return expandWhitespaceOnlyAnsiCQuotes(
    command
      .normalize('NFKC')
      .replace(ZERO_WIDTH_CHARACTERS, '')
      .replace(IFS_EXPANSIONS, ' '),
  );
}

/**
 * Produce the sole text form used before shell command policy and deny matching.
 * The parser deliberately does not execute substitutions. Dynamic substitutions and
 * malformed quoting are surfaced as unanalyzable so the permission layer can fail closed.
 */
export function canonicalizeCommand(command: string): {
  command: string;
  parsingFailed: boolean;
  failureReason?: string;
} {
  const source = normalizeShellText(command);
  let result = '';
  let mode: 'plain' | 'single' | 'double' | 'ansi' = 'plain';
  let parsingFailed = false;
  let failureReason: string | undefined;

  const fail = (reason: string): void => {
    parsingFailed = true;
    failureReason ??= reason;
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];

    if (mode === 'plain') {
      if (character === '$' && source[index + 1] === "'") {
        mode = 'ansi';
        index += 2;
      } else if (character === '$' && source[index + 1] === '"') {
        mode = 'double';
        index += 2;
      } else if (character === "'") {
        mode = 'single';
        index += 1;
      } else if (character === '"') {
        mode = 'double';
        index += 1;
      } else if (character === '\\') {
        const escaped = source[index + 1];
        if (escaped === undefined) {
          fail('trailing escape');
          index += 1;
        } else {
          if (escaped !== '\n' && escaped !== '\r') result += escaped;
          index += escaped === '\r' && source[index + 2] === '\n' ? 3 : 2;
        }
      } else {
        if (character === '`' || (character === '$' && source[index + 1] === '(')) {
          fail('dynamic command substitution cannot be resolved statically');
        }
        if (character === '\0') fail('NUL byte cannot be tokenized as a shell command');
        result += character;
        index += 1;
      }
      continue;
    }

    if (mode === 'single') {
      if (character === "'") mode = 'plain';
      else result += character;
      index += 1;
      continue;
    }

    if (mode === 'double') {
      if (character === '"') {
        mode = 'plain';
        index += 1;
        continue;
      }
      if (character === '\\') {
        const escaped = source[index + 1];
        if (escaped === undefined) {
          fail('trailing escape in double-quoted word');
          index += 1;
          continue;
        }
        if (['$', '`', '"', '\\', '\n', '\r'].includes(escaped)) {
          if (escaped !== '\n' && escaped !== '\r') result += escaped;
          index += escaped === '\r' && source[index + 2] === '\n' ? 3 : 2;
          continue;
        }
      }
      if (character === '`' || (character === '$' && source[index + 1] === '(')) {
        fail('dynamic command substitution cannot be resolved statically');
      }
      result += character;
      index += 1;
      continue;
    }

    if (character === "'") {
      mode = 'plain';
      index += 1;
      continue;
    }
    if (character !== '\\') {
      result += character;
      index += 1;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) {
      fail('trailing escape in ANSI-C quoted word');
      index += 1;
      continue;
    }
    const namedEscape = ANSI_C_ESCAPES[escaped];
    if (namedEscape !== undefined) {
      result += namedEscape;
      index += 2;
      continue;
    }
    const encoded = escaped === 'x'
      ? source.slice(index + 2).match(/^[0-9a-fA-F]{1,2}/)?.[0]
      : escaped === 'u'
        ? source.slice(index + 2).match(/^[0-9a-fA-F]{1,4}/)?.[0]
        : escaped === 'U'
          ? source.slice(index + 2).match(/^[0-9a-fA-F]{1,8}/)?.[0]
          : source.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    const isUnicodeEscape = escaped === 'u' || escaped === 'U';
    const radix = escaped === 'x' || isUnicodeEscape ? 16 : 8;
    if (encoded !== undefined) {
      const value = Number.parseInt(encoded, radix);
      if (!isUnicodeEscape || value <= 0x10ffff) {
        result += isUnicodeEscape ? String.fromCodePoint(value) : String.fromCharCode(value);
        index += encoded.length + (radix === 16 ? 2 : 1);
        continue;
      }
      fail('ANSI-C Unicode escape is outside the valid code point range');
    }
    result += escaped;
    index += 2;
  }

  if (mode !== 'plain') fail(`unclosed ${mode} quote`);

  return {
    command: result.replace(/\s+/g, ' ').trim(),
    parsingFailed,
    ...(failureReason ? { failureReason } : {}),
  };
}
