// Anchor hint helpers for Edit/multiEdit failure messages.
// Shared between legacy `tools/file/multiEdit.ts` and migrated
// `tools/modules/file/multiEdit.ts` (P0-5 ToolModule).

const ANCHOR_TOKEN_PATTERN = /[A-Za-z_$][\w$-]{2,}|['"`]([^'"`]{3,})['"`]/g;
const ANCHOR_TOKEN_STOP_WORDS = new Set([
  'const', 'let', 'var', 'true', 'false', 'null', 'undefined', 'return', 'function',
]);
const ANCHOR_TOKEN_LIMIT = 12;
const ANCHOR_HINT_TOP_LINES = 3;
const ANCHOR_HINT_PREVIEW_BUDGET = 14;
const ANCHOR_HINT_CONTEXT_BEFORE = 2;
const ANCHOR_HINT_CONTEXT_AFTER = 4;

export function extractAnchorTokens(oldText: string): string[] {
  const tokens = new Set<string>();
  for (const match of oldText.matchAll(ANCHOR_TOKEN_PATTERN)) {
    const token = (match[1] || match[0] || '').trim().toLowerCase();
    if (token.length >= 3 && !ANCHOR_TOKEN_STOP_WORDS.has(token)) {
      tokens.add(token);
    }
    if (tokens.size >= ANCHOR_TOKEN_LIMIT) break;
  }
  return [...tokens];
}

export function buildNearestAnchorHint(content: string, oldText: string): string | null {
  const tokens = extractAnchorTokens(oldText);
  if (tokens.length === 0) return null;

  const lines = content.split(/\r?\n/);
  const scored = lines
    .map((line, index) => {
      const lower = line.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
      return { index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, ANCHOR_HINT_TOP_LINES);

  if (scored.length === 0) return null;

  const ranges: Array<{ start: number; end: number }> = [];
  for (const entry of scored) {
    const start = Math.max(0, entry.index - ANCHOR_HINT_CONTEXT_BEFORE);
    const end = Math.min(lines.length - 1, entry.index + ANCHOR_HINT_CONTEXT_AFTER);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const previewLines: string[] = [];
  for (const range of ranges) {
    for (let index = range.start; index <= range.end && previewLines.length < ANCHOR_HINT_PREVIEW_BUDGET; index += 1) {
      previewLines.push(`${index + 1}: ${lines[index]}`);
    }
    if (previewLines.length >= ANCHOR_HINT_PREVIEW_BUDGET) break;
  }

  if (previewLines.length === 0) return null;
  return [
    ' Closest current file context for old_text anchors:',
    ...previewLines.map((line) => `  ${line}`),
  ].join('\n');
}
