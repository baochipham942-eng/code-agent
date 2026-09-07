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

/**
 * Decode the body of an ANSI-C quoted word (`$'…'` without the quotes) the way bash does: escapes
 * only. No whitespace folding and no Unicode normalization — those shape the whole-command canonical
 * text below, not a single word's identity (`l$' 's` is the program `l s`, never `ls`).
 */
export function decodeAnsiCQuotedBody(body: string): { text: string; failureReason?: string } {
  let text = '';
  let failureReason: string | undefined;
  let index = 0;
  while (index < body.length) {
    const character = body[index];
    if (character !== '\\') {
      text += character;
      index += 1;
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === undefined) {
      failureReason ??= 'trailing escape in ANSI-C quoted word';
      index += 1;
      continue;
    }
    const namedEscape = ANSI_C_ESCAPES[escaped];
    if (namedEscape !== undefined) {
      text += namedEscape;
      index += 2;
      continue;
    }
    const encoded = escaped === 'x'
      ? body.slice(index + 2).match(/^[0-9a-fA-F]{1,2}/)?.[0]
      : escaped === 'u'
        ? body.slice(index + 2).match(/^[0-9a-fA-F]{1,4}/)?.[0]
        : escaped === 'U'
          ? body.slice(index + 2).match(/^[0-9a-fA-F]{1,8}/)?.[0]
          : body.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    const isUnicodeEscape = escaped === 'u' || escaped === 'U';
    const radix = escaped === 'x' || isUnicodeEscape ? 16 : 8;
    if (encoded !== undefined) {
      const value = Number.parseInt(encoded, radix);
      if (!isUnicodeEscape || value <= 0x10ffff) {
        text += isUnicodeEscape ? String.fromCodePoint(value) : String.fromCharCode(value);
        index += encoded.length + (radix === 16 ? 2 : 1);
        continue;
      }
      failureReason ??= 'ANSI-C Unicode escape is outside the valid code point range';
    }
    text += escaped;
    index += 2;
  }
  return { text, ...(failureReason ? { failureReason } : {}) };
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
  const source = command
    .normalize('NFKC')
    .replace(ZERO_WIDTH_CHARACTERS, '')
    .replace(IFS_EXPANSIONS, ' ');
  let result = '';
  let mode: 'plain' | 'single' | 'double' = 'plain';
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
        let end = index + 2;
        while (end < source.length && source[end] !== "'") end += source[end] === '\\' ? 2 : 1;
        const decoded = decodeAnsiCQuotedBody(source.slice(index + 2, Math.min(end, source.length)));
        result += decoded.text;
        if (decoded.failureReason) fail(decoded.failureReason);
        if (end >= source.length) fail('unclosed ansi quote');
        index = end + 1;
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

  }

  if (mode !== 'plain') fail(`unclosed ${mode} quote`);

  return {
    command: result.replace(/\s+/g, ' ').trim(),
    parsingFailed,
    ...(failureReason ? { failureReason } : {}),
  };
}
