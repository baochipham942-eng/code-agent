/**
 * Length-preserving mask of HTML/JS/CSS comments (and optionally JS string
 * interiors) in generated game artifacts.
 *
 * Indices stay aligned with the original so assignment extractors can slice
 * the real source after matching on the masked view.
 *
 * Two views, not one:
 *   comments                  — HTML/JS/CSS comments become spaces. String
 *                               contents stay. Use for tokens that legitimately
 *                               live in strings (keydown, quoted JSON keys).
 *   comments-and-js-strings   — also blank JS string/template interiors inside
 *                               <script> (not application/json). Use for
 *                               identifier/assignment constructs such as
 *                               window.__GAME_META__ = {.
 */

export type ArtifactSourceMaskMode = 'comments' | 'comments-and-js-strings';

const REGEXP_AFTER_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'else',
  'do',
  'in',
  'of',
  'typeof',
  'void',
  'delete',
  'new',
  'await',
  'yield',
  'instanceof',
]);

function isIdentStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function isNewline(char: string): boolean {
  return char === '\n' || char === '\r';
}

export function maskArtifactSource(
  content: string,
  mode: ArtifactSourceMaskMode = 'comments',
): string {
  const out = content.split('');
  const maskStrings = mode === 'comments-and-js-strings';
  const n = content.length;
  let i = 0;
  let exprState: 'operand' | 'operator' = 'operator';

  const maskRange = (from: number, to: number): void => {
    const end = Math.min(to, n);
    for (let index = from; index < end; index += 1) {
      if (!isNewline(out[index] ?? '')) out[index] = ' ';
    }
  };

  const peek = (offset = 0): string => content[i + offset] ?? '';

  const startsAt = (token: string): boolean => {
    if (i + token.length > n) return false;
    return content.slice(i, i + token.length).toLowerCase() === token.toLowerCase();
  };

  const readIdent = (): string => {
    const start = i;
    i += 1;
    while (i < n && isIdentPart(content[i] ?? '')) i += 1;
    return content.slice(start, i);
  };

  const skipJsString = (quote: string): void => {
    let segmentStart = i + 1;
    i += 1;
    let escaped = false;
    while (i < n) {
      const char = content[i] ?? '';
      if (escaped) {
        escaped = false;
        i += 1;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        i += 1;
        continue;
      }
      if (quote === '`' && char === '$' && peek(1) === '{') {
        if (maskStrings) maskRange(segmentStart, i);
        i += 2;
        scanJs(() => peek() === '}' && jsBraceDepth === 0, { templateExpr: true });
        if (peek() === '}') i += 1;
        segmentStart = i;
        escaped = false;
        continue;
      }
      if (char === quote) {
        if (maskStrings) maskRange(segmentStart, i);
        i += 1;
        return;
      }
      i += 1;
    }
    if (maskStrings) maskRange(segmentStart, n);
  };

  let jsBraceDepth = 0;

  const skipJsLineComment = (): void => {
    const start = i;
    while (i < n && !isNewline(content[i] ?? '')) i += 1;
    maskRange(start, i);
  };

  const skipJsBlockComment = (): void => {
    const start = i;
    i += 2;
    while (i < n && !(content[i] === '*' && peek(1) === '/')) i += 1;
    if (i < n) i += 2;
    maskRange(start, i);
  };

  const skipRegexp = (): void => {
    i += 1;
    let escaped = false;
    let inClass = false;
    while (i < n) {
      const char = content[i] ?? '';
      if (escaped) {
        escaped = false;
        i += 1;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        i += 1;
        continue;
      }
      if (char === '[' && !inClass) {
        inClass = true;
        i += 1;
        continue;
      }
      if (char === ']' && inClass) {
        inClass = false;
        i += 1;
        continue;
      }
      if (char === '/' && !inClass) {
        i += 1;
        while (i < n && /[A-Za-z]/.test(content[i] ?? '')) i += 1;
        return;
      }
      if (isNewline(char)) return;
      i += 1;
    }
  };

  const scanJs = (
    shouldStop: () => boolean,
    options: { templateExpr?: boolean } = {},
  ): void => {
    const savedDepth = jsBraceDepth;
    if (options.templateExpr) jsBraceDepth = 0;
    while (i < n && !shouldStop()) {
      const char = content[i] ?? '';
      const next = peek(1);
      if (char === '/' && next === '/') {
        skipJsLineComment();
        continue;
      }
      if (char === '/' && next === '*') {
        skipJsBlockComment();
        continue;
      }
      if (char === '<' && next === '!' && peek(2) === '-' && peek(3) === '-') {
        skipJsLineComment();
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        skipJsString(char);
        exprState = 'operand';
        continue;
      }
      if (char === '/' && exprState === 'operator') {
        skipRegexp();
        exprState = 'operand';
        continue;
      }
      if (char === '{') {
        jsBraceDepth += 1;
        exprState = 'operator';
        i += 1;
        continue;
      }
      if (char === '}') {
        if (options.templateExpr && jsBraceDepth === 0) break;
        jsBraceDepth = Math.max(0, jsBraceDepth - 1);
        exprState = 'operand';
        i += 1;
        continue;
      }
      if (isIdentStart(char)) {
        const ident = readIdent();
        exprState = REGEXP_AFTER_KEYWORDS.has(ident) ? 'operator' : 'operand';
        continue;
      }
      if (/\d/.test(char)) {
        i += 1;
        while (i < n && /[\d.eE_]/.test(content[i] ?? '')) i += 1;
        exprState = 'operand';
        continue;
      }
      if (/\s/.test(char)) {
        i += 1;
        continue;
      }
      if (char === ')' || char === ']') {
        exprState = 'operand';
        i += 1;
        continue;
      }
      exprState = 'operator';
      i += 1;
    }
    if (options.templateExpr) jsBraceDepth = savedDepth;
  };

  const scanCss = (): void => {
    while (i < n && !atStyleClose()) {
      const char = content[i] ?? '';
      const next = peek(1);
      if (char === '/' && next === '*') {
        skipJsBlockComment();
        continue;
      }
      if (char === '"' || char === "'") {
        const quote = char;
        i += 1;
        let escaped = false;
        while (i < n) {
          const current = content[i] ?? '';
          if (escaped) {
            escaped = false;
            i += 1;
            continue;
          }
          if (current === '\\') {
            escaped = true;
            i += 1;
            continue;
          }
          if (current === quote) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      i += 1;
    }
  };

  const atScriptClose = (): boolean => {
    if (!startsAt('</script')) return false;
    const after = content[i + 8] ?? '';
    return after === '>' || after === '/' || /\s/.test(after);
  };

  const atStyleClose = (): boolean => {
    if (!startsAt('</style')) return false;
    const after = content[i + 7] ?? '';
    return after === '>' || after === '/' || /\s/.test(after);
  };

  const readHtmlTag = (): { name: string; closing: boolean; selfClosing: boolean; typeAttr: string } => {
    i += 1;
    const closing = content[i] === '/';
    if (closing) i += 1;
    const nameStart = i;
    while (i < n && /[A-Za-z0-9:-]/.test(content[i] ?? '')) i += 1;
    const name = content.slice(nameStart, i).toLowerCase();
    let typeAttr = '';
    let quote: string | null = null;
    let attrNameBuf = '';
    let pendingAttr = '';
    while (i < n) {
      const char = content[i] ?? '';
      if (quote) {
        if (char === quote) quote = null;
        i += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        if (pendingAttr === 'type') {
          const valueStart = i + 1;
          i += 1;
          while (i < n && content[i] !== char) i += 1;
          typeAttr = content.slice(valueStart, i).trim().toLowerCase();
          if (content[i] === char) i += 1;
          pendingAttr = '';
          attrNameBuf = '';
          continue;
        }
        quote = char;
        i += 1;
        continue;
      }
      if (char === '>') {
        const selfClosing = content[i - 1] === '/';
        i += 1;
        return { name, closing, selfClosing, typeAttr };
      }
      if (char === '=') {
        pendingAttr = attrNameBuf;
        attrNameBuf = '';
        i += 1;
        continue;
      }
      if (/\s/.test(char) || char === '/') {
        attrNameBuf = '';
        i += 1;
        continue;
      }
      attrNameBuf += char.toLowerCase();
      i += 1;
    }
    return { name, closing, selfClosing: false, typeAttr };
  };

  while (i < n) {
    if (startsAt('<!--')) {
      const start = i;
      i += 4;
      while (i < n && !startsAt('-->')) i += 1;
      if (i < n) i += 3;
      maskRange(start, i);
      continue;
    }
    if (content[i] === '<' && /[A-Za-z/]/.test(peek(1))) {
      const tag = readHtmlTag();
      if (tag.name === 'script' && !tag.closing && !tag.selfClosing) {
        const isJson = tag.typeAttr.includes('json');
        if (isJson) {
          while (i < n && !atScriptClose()) i += 1;
        } else {
          exprState = 'operator';
          jsBraceDepth = 0;
          scanJs(atScriptClose);
        }
        if (atScriptClose()) readHtmlTag();
        continue;
      }
      if (tag.name === 'style' && !tag.closing && !tag.selfClosing) {
        scanCss();
        if (atStyleClose()) readHtmlTag();
        continue;
      }
      continue;
    }
    i += 1;
  }

  return out.join('');
}
