// ============================================================================
// priorRunProjection — retry = projection continuation（长任务收口）
//
// 失败 run 重试时，从 session 一本账（buildSessionLedger 产物）派生一段
// 有界、结构化的"上一 run 现场"：未完成任务末态 + 最近失败的验证/工具错误。
// 注入新 attempt 的恢复提案 prompt，替代模型从 transcript 从头考古。
// 纯函数、只读、fail-safe：无现场可投影返回 null，调用方回退纯文本提案。
// ============================================================================

import type { LedgerEntry, SessionLedger } from '../../shared/contract/sessionLedger';

/** 任务末态属于这些 kind 即视为已终结，不进"未完成"清单（taskStore：cancelled 落账为 abandoned） */
const TERMINAL_TASK_KINDS = new Set(['done', 'deleted', 'cancelled', 'abandoned']);

/** 最近失败错误取尾部条数（有界：控 prompt token） */
const MAX_FAILURE_ENTRIES = 5;
const MAX_UNFINISHED_TASKS = 10;
const DEFAULT_MAX_CHARS = 1_800;

export interface PriorRunProjectionOptions {
  maxChars?: number;
}

function unfinishedTasks(entries: LedgerEntry[]): string[] {
  // 每个 taskId 只看末态事件（entries 已按 at 升序）
  const lastByTask = new Map<string, LedgerEntry>();
  for (const e of entries) {
    if (e.lane !== 'task' || !e.refId) continue;
    // delete+set 刷新插入序：slice(-N) 取的是"最近有动静的任务"而非首次出现序
    lastByTask.delete(e.refId);
    lastByTask.set(e.refId, e);
  }
  const open = [...lastByTask.values()].filter((e) => !TERMINAL_TASK_KINDS.has(e.kind));
  return open.slice(-MAX_UNFINISHED_TASKS).map((e) => `- [${e.kind}] ${e.summary}`);
}

function recentFailures(entries: LedgerEntry[]): string[] {
  const failures = entries.filter(
    (e) => e.lane === 'execution' && e.kind.endsWith(':error'),
  );
  return failures.slice(-MAX_FAILURE_ENTRIES).map((e) => {
    const err = typeof e.detail?.error === 'string' ? `（${e.detail.error}）` : '';
    return `- ${e.summary}${err}`;
  });
}

/** 截断到 maxChars，按完整行收尾并追加省略号 */
function boundText(lines: string[], maxChars: number): string {
  const full = lines.join('\n');
  if (full.length <= maxChars) return full;
  let out = '';
  for (const line of lines) {
    // 预留 1 字符给省略号
    if (out.length + line.length + 1 > maxChars - 1) break;
    out += (out ? '\n' : '') + line;
  }
  return `${out}\n…`.slice(0, maxChars);
}

/**
 * 从 session 一本账派生有界现场投影。
 * @returns 结构化文本块；无未完成任务且无失败事件时返回 null。
 */
export function buildPriorRunProjection(
  ledger: SessionLedger,
  options: PriorRunProjectionOptions = {},
): string | null {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const tasks = unfinishedTasks(ledger.entries);
  const failures = recentFailures(ledger.entries);
  if (tasks.length === 0 && failures.length === 0) return null;

  const lines: string[] = [];
  if (tasks.length > 0) {
    lines.push('未完成任务（末态）：', ...tasks);
  }
  if (failures.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('最近失败的验证/工具执行：', ...failures);
  }
  return boundText(lines, maxChars);
}
