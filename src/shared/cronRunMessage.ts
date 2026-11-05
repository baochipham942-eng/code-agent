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

// buildCronAgentPrompt（src/host/cron/cronAgentPrompt.ts）在用户任务后面追加的
// 机器尾段以「空行 + 【当前时间】+ ISO 时间戳 + （UTC）。」开头。这个开头是
// host 侧拼出来的固定结构（toISOString 无空格），用户手打不出来；按它切割只可能
// 命中 cron 注入的尾段。事件触发 run 的事件载荷块拼在尾段之后，一起被切掉。
const CRON_PROMPT_TAIL_PATTERN = /\n\n【当前时间】\d{4}-\d{2}-\d{2}T[\d:.]+Z（UTC）。/;

/**
 * 用户气泡只显示任务本身：去掉 cron host 注入的时间锚点 / 快照 / 摘要指令尾段。
 * 只动展示，不动存储——发给模型的消息内容逐字节保持原样（含 fork 出的续聊子会话
 * 复制到的前缀）。没有尾段（普通会话、手输消息）时原样返回。
 */
export function stripCronPromptDecoration(source: string): string {
  const match = CRON_PROMPT_TAIL_PATTERN.exec(source);
  if (!match) return source;
  return source.slice(0, match.index).trimEnd();
}
