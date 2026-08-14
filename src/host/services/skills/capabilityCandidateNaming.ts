// ============================================================================
// 候选能力的「模型分」—— 只起人话名 + 写一句「它是什么」（N-CAP1 / F1）
// ============================================================================
// 硬约束（方案 §二.5(1续A)）：模型产出**仅展示，绝不参与排序**。
// 让它写描述——错了人一眼看出；让它定优先级——错了人看不出。
// 因此本文件只写 displayName / summary 两个展示字段，
// 排序主键 mechanicalScoreOf() 里不出现这两个字段。
//
// 时机：打开候选列表时按需补齐（懒补），补完落账本缓存。
// 不在后台跑、不在每轮跑——否则就是拿用户的钱给一张没人看的表起名。

import { CAPABILITY_CANDIDATES } from '../../../shared/constants';
import type { CapabilityCandidateRecord } from '../../../shared/contract/capabilityCandidate';
import { getCapabilityCandidateStore } from './capabilityCandidateStore';
import { createLogger } from '../infra/logger';

const logger = createLogger('CapabilityCandidateNaming');

const NAMING_MAX_TOKENS = 512;

/** 机械兜底名：模型不可用 / 调用失败时列表照样有话可说，不留空行 */
export function fallbackName(record: CapabilityCandidateRecord): string {
  return record.shapeTokens.join(' + ');
}

function buildPrompt(records: CapabilityCandidateRecord[]): string {
  const items = records.map((record, index) => [
    `[${index + 1}]`,
    `重复次数：${record.occurrences}`,
    `每次用到：${record.shapeTokens.join(', ')}`,
    `步骤顺序样例：${record.variants.slice(0, 2).join(' | ')}`,
    record.sampleUserMessages.length > 0
      ? `用户当时说的话：${record.sampleUserMessages.join(' / ')}`
      : '用户原话：无',
  ].join('\n')).join('\n\n');

  return [
    '下面每一条，都是同一个助手反复用一组工具拼凑完成的同一类事情。',
    '请给每一条起一个「人话名字」，并写一句「它是什么」。',
    '',
    '要求：',
    '- 名字 ≤ 12 个字，用做事的说法（例：把截图里的表格转成 Excel），不要用工具名、不要用英文命令名。',
    '- 说明 ≤ 30 个字，说清这件事是干什么的。',
    '- 不要评价值不值得做、不要排优先级、不要建议怎么实现。',
    '- 严格输出 JSON 数组，不要代码块围栏，格式：',
    '  [{"index":1,"name":"...","summary":"..."}]',
    '',
    items,
  ].join('\n');
}

interface NamingReply {
  index?: number;
  name?: string;
  summary?: string;
}

function parseNamingReply(content: string): NamingReply[] {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed as NamingReply[] : [];
  } catch {
    return [];
  }
}

/**
 * 给还没有人话名的候选补名字。一次一批，失败静默降级到机械兜底名。
 * 返回真正写入名字的条数（给调用方判断要不要重新读列表）。
 */
export async function fillMissingNames(records: CapabilityCandidateRecord[]): Promise<number> {
  const pending = records
    .filter((record) => !record.displayName)
    .slice(0, CAPABILITY_CANDIDATES.AGENT_NOTICE_MAX_ENTRIES * 2);
  if (pending.length === 0) return 0;

  let content: string | undefined;
  try {
    const { quickTask, isQuickModelAvailable } = await import('../../model/quickModel');
    if (!isQuickModelAvailable()) return 0;
    const result = await quickTask(buildPrompt(pending), NAMING_MAX_TOKENS);
    if (!result.success || !result.content) return 0;
    content = result.content;
  } catch (error) {
    logger.debug('候选能力起名跳过（模型不可用）', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }

  const store = getCapabilityCandidateStore();
  let written = 0;
  for (const reply of parseNamingReply(content)) {
    const target = pending[(reply.index ?? 0) - 1];
    const name = typeof reply.name === 'string' ? reply.name.trim() : '';
    if (!target || !name) continue;
    const current = store.get(target.clusterKey);
    if (!current) continue;
    store.put({
      ...current,
      displayName: name.slice(0, 40),
      summary: typeof reply.summary === 'string' ? reply.summary.trim().slice(0, 80) : current.summary,
    });
    written += 1;
  }
  return written;
}
