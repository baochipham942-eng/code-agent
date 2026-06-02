// ============================================================================
// Failure Journal — 跨会话失败模式日志（GAP-005）
// learningPipeline 在 session 结束时把 telemetry 里的重复失败模式合并到
// Light Memory 主题文件 failure-journal.md；新 session 构建 system prompt 时
// 注入该文件内容，避免重复踩坑。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getMemoryDir, getMemoryIndexPath, ensureMemoryDir } from './indexLoader';
import { writeLightMemoryFile } from './lightMemoryIpc';
import { LEARNING_PIPELINE } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('FailureJournal');

/** journal 文件中嵌入的机器可读数据标记（用于跨会话精确合并计数） */
const JOURNAL_JSON_MARKER = 'FAILURE_JOURNAL_JSON';

export interface FailurePattern {
  /** 去重 key：toolName + errorCategory + 归一化错误消息 */
  key: string;
  toolName: string;
  errorCategory: string;
  /** 归一化后的错误消息（数字→N、引号内容→"..."、截断） */
  pattern: string;
  /** 累计出现次数（跨会话累加） */
  count: number;
  /** 出现过的 session id（最多保留最近 N 个） */
  sessions: string[];
  firstSeen: number;
  lastSeen: number;
  /** 原始错误消息样本（截断） */
  sampleError: string;
}

// ----------------------------------------------------------------------------
// 模式归一化（与 planning/errorTracker.getErrorKey 同源逻辑，但用于跨会话维度）
// ----------------------------------------------------------------------------

export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/\d+/g, 'N')
    .replace(/['"][^'"]*['"]/g, '"..."')
    .substring(0, LEARNING_PIPELINE.ERROR_PATTERN_MAX_CHARS);
}

export function buildFailurePatternKey(
  toolName: string,
  errorCategory: string,
  message: string,
): string {
  return `${toolName}:${errorCategory}:${normalizeErrorMessage(message)}`;
}

// ----------------------------------------------------------------------------
// 读写
// ----------------------------------------------------------------------------

function getJournalPath(): string {
  return path.join(getMemoryDir(), LEARNING_PIPELINE.JOURNAL_FILENAME);
}

/**
 * 读取 journal 的结构化条目。文件不存在或无法解析时返回空数组。
 */
export async function loadFailureJournalEntries(): Promise<FailurePattern[]> {
  try {
    const content = await fs.readFile(getJournalPath(), 'utf-8');
    const match = content.match(new RegExp(`<!-- ${JOURNAL_JSON_MARKER}: (.+) -->`));
    if (!match) return [];
    const parsed = JSON.parse(match[1]) as FailurePattern[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 把本次 session 提取到的失败模式合并进 journal（按 key 累加计数），
 * 落盘到 Light Memory 并保证 INDEX.md 有对应条目。
 * 返回本次新增或更新的模式数。
 */
export async function recordFailurePatterns(
  patterns: FailurePattern[],
  timestamp?: number,
): Promise<number> {
  if (patterns.length === 0) return 0;
  const now = timestamp ?? Date.now();

  const existing = await loadFailureJournalEntries();
  const byKey = new Map<string, FailurePattern>(existing.map((entry) => [entry.key, entry]));

  let changed = 0;
  for (const incoming of patterns) {
    const prior = byKey.get(incoming.key);
    if (prior) {
      prior.count += incoming.count;
      prior.lastSeen = Math.max(prior.lastSeen, incoming.lastSeen || now);
      prior.sampleError = incoming.sampleError || prior.sampleError;
      const sessions = new Set([...prior.sessions, ...incoming.sessions]);
      prior.sessions = Array.from(sessions).slice(-LEARNING_PIPELINE.JOURNAL_MAX_SESSIONS_PER_ENTRY);
    } else {
      byKey.set(incoming.key, { ...incoming });
    }
    changed++;
  }

  // 超出预算按 lastSeen 淘汰最旧的模式
  const entries = Array.from(byKey.values())
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, LEARNING_PIPELINE.JOURNAL_MAX_ENTRIES);

  await ensureMemoryDir();
  await writeLightMemoryFile({
    filename: LEARNING_PIPELINE.JOURNAL_FILENAME,
    name: 'failure-journal',
    description: `跨会话失败模式日志（自动沉淀，${entries.length} 条），新会话注入避免重复踩坑`,
    type: 'failure-journal',
    content: renderJournalBody(entries),
    source: 'learning-pipeline',
  });
  await ensureIndexEntry(
    LEARNING_PIPELINE.JOURNAL_FILENAME,
    `跨会话失败模式日志（自动沉淀，${entries.length} 条），新会话注入避免重复踩坑`,
  );

  logger.info('Failure journal updated', { merged: changed, total: entries.length });
  return changed;
}

function renderJournalBody(entries: FailurePattern[]): string {
  const lines: string[] = [
    '> 自动从 telemetry 提取的重复失败模式（同一模式 ≥3 次）。',
    '> 新会话执行同类操作前先检查这里，避免重复踩坑。',
    '',
  ];

  for (const entry of entries) {
    const lastSeen = new Date(entry.lastSeen).toISOString().split('T')[0];
    lines.push(`## ${entry.toolName} · ${entry.errorCategory}`);
    lines.push('');
    lines.push(`- **模式**: ${entry.pattern}`);
    lines.push(`- **累计次数**: ${entry.count}（跨 ${entry.sessions.length} 个 session）`);
    lines.push(`- **最近出现**: ${lastSeen}`);
    lines.push(`- **错误样本**: ${entry.sampleError}`);
    lines.push('');
  }

  lines.push('');
  lines.push(`<!-- ${JOURNAL_JSON_MARKER}: ${JSON.stringify(entries)} -->`);
  return lines.join('\n');
}

/**
 * 确保 INDEX.md 中有 journal 的条目（writeLightMemoryFile 本身不维护 INDEX）。
 */
async function ensureIndexEntry(filename: string, description: string): Promise<void> {
  const indexPath = getMemoryIndexPath();
  const entryLine = `- [${filename}](${filename}) — ${description}`;
  let content: string;
  try {
    content = await fs.readFile(indexPath, 'utf-8');
  } catch {
    content = '# Memory Index\n';
  }

  const lines = content.split('\n');
  const existingIdx = lines.findIndex((line) => line.startsWith(`- [${filename}]`));
  if (existingIdx >= 0) {
    lines[existingIdx] = entryLine;
  } else {
    lines.push(entryLine);
  }
  await fs.writeFile(indexPath, `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`, 'utf-8');
}

// ----------------------------------------------------------------------------
// System prompt 注入
// ----------------------------------------------------------------------------

/**
 * 构建注入 system prompt 的 failure journal 块。
 * journal 为空或不存在时返回 null。
 */
export async function buildFailureJournalBlock(): Promise<string | null> {
  const entries = await loadFailureJournalEntries();
  if (entries.length === 0) return null;

  const top = entries
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, LEARNING_PIPELINE.INJECTION_MAX_ENTRIES);

  const lines = top.map((entry) =>
    `- ${entry.toolName} (${entry.errorCategory}, ${entry.count}次): ${entry.pattern}`,
  );

  return [
    '<failure_journal>',
    '以下是历史会话中重复出现（≥3 次）的失败模式。执行同类操作前先规避这些已知坑：',
    ...lines,
    '</failure_journal>',
  ].join('\n');
}
