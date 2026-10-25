// ============================================================================
// Split cron/heartbeat assistant text into prose, alert bodies, and a summary.
// Machine tags stay out of the rendered string. Callers decide which sessions
// use this (origin kind cron or heartbeat).
// ============================================================================

interface CronRunMessageSegment {
  kind: 'text' | 'alert' | 'summary';
  text: string;
  artifacts: string[];
}

const CRON_MACHINE_BLOCK_SOURCE =
  '<cron_(snapshot|alert|summary)\\s*>([\\s\\S]*?)<\\/cron_\\1\\s*>|<cron_(snapshot|alert|summary)\\b[^>]*>[\\s\\S]*$';

const ARTIFACT_LINE = /^\s*artifact:\s*(\S.*)?\s*$/i;
const URGENCY_LINE = /^\s*urgency\s*:/i;

function pushText(segments: CronRunMessageSegment[], raw: string): void {
  const text = raw.replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return;
  segments.push({ kind: 'text', text, artifacts: [] });
}

function summarySegment(body: string): CronRunMessageSegment {
  const artifacts: string[] = [];
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (URGENCY_LINE.test(line)) continue;
    const artifact = line.match(ARTIFACT_LINE);
    if (artifact) {
      const path = artifact[1]?.trim();
      if (path && artifacts.length < 10) artifacts.push(path);
      continue;
    }
    lines.push(line);
  }
  return { kind: 'summary', text: lines.join('\n').trim(), artifacts };
}

function unclosedBody(match: string): string {
  return match.replace(/^<cron_[^>]*>/i, '').trim();
}

/**
 * Drop snapshot blocks, unwrap alert bodies, and turn each closed summary
 * into its own segment. An unclosed tag at the end is hidden (alert keeps
 * the body typed so far). Text with no machine tags comes back as one segment.
 */
export function splitCronRunMessage(source: string): CronRunMessageSegment[] {
  if (!source) return [];
  const segments: CronRunMessageSegment[] = [];
  const pattern = new RegExp(CRON_MACHINE_BLOCK_SOURCE, 'gi');
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) pushText(segments, source.slice(cursor, index));
    const closedKind = match[1]?.toLowerCase();
    const kind = closedKind || match[3]?.toLowerCase() || '';
    if (kind === 'alert') {
      const text = (closedKind ? match[2] : unclosedBody(match[0])).trim();
      if (text) segments.push({ kind: 'alert', text, artifacts: [] });
    } else if (kind === 'summary' && closedKind) {
      const summary = summarySegment(match[2] ?? '');
      if (summary.text || summary.artifacts.length > 0) segments.push(summary);
    }
    cursor = index + match[0].length;
  }
  if (cursor < source.length) pushText(segments, source.slice(cursor));
  return segments;
}
