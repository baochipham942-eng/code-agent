// ============================================================================
// File Path Processor - Wraps file paths in markdown with backtick inline code
// so that they become clickable in the MessageContent component.
// ============================================================================

/**
 * File path regex explanation:
 * - Absolute paths: /foo/bar.ts
 * - Relative paths: ./foo/bar.ts
 * - Home paths: ~/foo/bar.ts
 * - Multi-segment relative: src/foo/bar.ts (2+ segments with extension)
 * - Optional :lineNumber suffix: src/foo/bar.ts:42
 *
 * Excludes URLs (http:// or https://) and paths already in backticks or markdown links.
 */

// Match file paths with known extensions + optional :lineNumber suffix
// - Absolute: /path/to/file.ext
// - Relative: ./path/to/file.ext
// - Home: ~/path/to/file.ext
// - Multi-segment: src/path/file.ext (first segment starts with letter, rest can start with @)
const FILE_PATH_PATTERN =
  /(?:\/[\w.@-]+(?:\/[\w.@-]+)*\.\w+(?::\d+)?|\.\/[\w.@-]+(?:\/[\w.@-]+)*\.\w+(?::\d+)?|~\/[\w.@-]+(?:\/[\w.@-]+)*\.\w+(?::\d+)?|[a-zA-Z][\w.@-]*\/(?:[\w.@-]+\/)*[\w.@-]+\.\w+(?::\d+)?)/g;

/**
 * Split markdown content into segments, separating code blocks and inline code
 * from regular text. Only regular text segments should be processed.
 *
 * Returns array of { text, isCode } objects.
 */
function splitByCode(markdown: string): Array<{ text: string; isCode: boolean }> {
  const segments: Array<{ text: string; isCode: boolean }> = [];
  // Match fenced code blocks (``` ... ```) and inline code (` ... `)
  // Order matters: fenced blocks first (greedy), then inline code
  const codePattern = /```[\s\S]*?```|`[^`\n]+`/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(markdown)) !== null) {
    // Text before this code segment
    if (match.index > lastIndex) {
      segments.push({ text: markdown.slice(lastIndex, match.index), isCode: false });
    }
    // The code segment itself
    segments.push({ text: match[0], isCode: true });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code segment
  if (lastIndex < markdown.length) {
    segments.push({ text: markdown.slice(lastIndex), isCode: false });
  }

  return segments;
}

/**
 * Check if a path match is inside a markdown link syntax like [text](path) or ![alt](path)
 */
function isInsideMarkdownLink(text: string, matchIndex: number, matchLength: number): boolean {
  // Check if preceded by ]( — markdown link target
  const before = text.slice(Math.max(0, matchIndex - 2), matchIndex);
  if (before.endsWith('](')) {
    return true;
  }

  // Check if followed by ) — completing a markdown link
  const afterIndex = matchIndex + matchLength;
  if (afterIndex < text.length && text[afterIndex] === ')') {
    // Walk back to see if there's a ]( before the match
    const precedingText = text.slice(0, matchIndex);
    const lastLinkOpen = precedingText.lastIndexOf('](');
    if (lastLinkOpen !== -1) {
      // Check there's no ) between ]( and our match (i.e., the link isn't already closed)
      const between = precedingText.slice(lastLinkOpen + 2);
      if (!between.includes(')')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a match is part of a URL (has http:// or https:// prefix).
 * The regex captures paths starting with /, so for "https://example.com/foo.ts"
 * the match starts at the second / — the preceding text ends with "https:/".
 */
function isUrl(text: string, matchIndex: number): boolean {
  const prefixStart = Math.max(0, matchIndex - 8);
  const prefix = text.slice(prefixStart, matchIndex);
  // Match both "https://" (if regex somehow captured from //) and "https:/" (common case)
  return /https?:\/\/?$/.test(prefix);
}

/**
 * Process a non-code text segment: find file paths and wrap them in backticks.
 */
function processTextSegment(text: string): string {
  // Reset regex lastIndex
  FILE_PATH_PATTERN.lastIndex = 0;

  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FILE_PATH_PATTERN.exec(text)) !== null) {
    const matchedPath = match[0];
    const matchIndex = match.index;

    // Skip URLs
    if (isUrl(text, matchIndex)) {
      continue;
    }

    // Skip paths inside markdown link syntax
    if (isInsideMarkdownLink(text, matchIndex, matchedPath.length)) {
      continue;
    }

    // Skip if already wrapped in backticks (check char before and after)
    const charBefore = matchIndex > 0 ? text[matchIndex - 1] : '';
    const charAfter = matchIndex + matchedPath.length < text.length
      ? text[matchIndex + matchedPath.length]
      : '';
    if (charBefore === '`' || charAfter === '`') {
      continue;
    }

    // Wrap the path in backticks
    result += text.slice(lastIndex, matchIndex);
    result += '`' + matchedPath + '`';
    lastIndex = matchIndex + matchedPath.length;
  }

  // Append remaining text
  result += text.slice(lastIndex);
  return result;
}

/**
 * Wrap file paths found in markdown content with backtick inline code,
 * so that the InlineCode component can make them clickable.
 *
 * Preserves content inside fenced code blocks and existing inline code.
 */
export function wrapFilePathsInBackticks(markdown: string): string {
  const segments = splitByCode(markdown);

  return segments
    .map(segment => {
      if (segment.isCode) {
        return segment.text; // Don't process code segments
      }
      return processTextSegment(segment.text);
    })
    .join('');
}

// ============================================================================
// Ticket ID auto-link: 识别形如 DSECDCN-1988、JIRA-42 的 issue key，转成
// [ID](!ticket) 的 IACT 链接，由 MessageContent 的 a renderer 分支点击复制 ID。
// 故意不做 git sha — 7-40 hex 字符误伤率太高。
// ============================================================================

const TICKET_PATTERN = /\b[A-Z]{2,10}-\d{1,6}\b/g;

function processTicketSegment(text: string): string {
  TICKET_PATTERN.lastIndex = 0;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TICKET_PATTERN.exec(text)) !== null) {
    const matched = match[0];
    const matchIndex = match.index;

    if (isInsideMarkdownLink(text, matchIndex, matched.length)) continue;

    // Skip if already wrapped in backticks
    const charBefore = matchIndex > 0 ? text[matchIndex - 1] : '';
    const charAfter = matchIndex + matched.length < text.length
      ? text[matchIndex + matched.length]
      : '';
    if (charBefore === '`' || charAfter === '`') continue;

    result += text.slice(lastIndex, matchIndex);
    result += `[${matched}](!ticket)`;
    lastIndex = matchIndex + matched.length;
  }

  result += text.slice(lastIndex);
  return result;
}

export function wrapTicketsAsLinks(markdown: string): string {
  const segments = splitByCode(markdown);
  return segments
    .map(segment => (segment.isCode ? segment.text : processTicketSegment(segment.text)))
    .join('');
}
