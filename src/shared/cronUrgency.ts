// ============================================================================
// Cron Urgency — 运行结果头部行的紧急档位解析（N-CRON-INBOX-URGENCY-TIER）
// ----------------------------------------------------------------------------
// 只认结果文本头部的一行 `urgency: must_today|can_wait|fyi`（大小写不敏感），
// 不做任何语义判断。缺头/乱值一律归 fyi：收件箱排序永不因模型乱写而炸，
// 乱值的原文经 raw 保留下来给用户看。
// ============================================================================

import type { CronUrgency } from './contract/sessionAutomation';

const URGENCY_HEADER_PATTERN = /^\s*urgency\s*:\s*(\S+)\s*$/i;

const CRON_URGENCY_VALUES: readonly CronUrgency[] = ['must_today', 'can_wait', 'fyi'];

export function isCronUrgency(value: unknown): value is CronUrgency {
  return typeof value === 'string' && (CRON_URGENCY_VALUES as readonly string[]).includes(value);
}

/**
 * 剥掉开头空行后在前 3 行里找第一条 urgency 头部行，返回整行与小写值；没有
 * 匹配行返回 undefined。parseUrgencyHeader 的档位归并（收件箱排序）与
 * declaresCronUrgencyQuiet 的安静声明判读（通知门）共用这份扫描语义，
 * 改窗口/正则时两边一起动。
 */
function findUrgencyHeaderLine(text?: string): { line: string; value: string } | undefined {
  if (typeof text !== 'string') return undefined;

  try {
    const lines = text.split(/\r?\n/);
    let start = 0;
    while (start < lines.length && lines[start].trim() === '') start += 1;
    for (let offset = 0; offset < 3 && start + offset < lines.length; offset += 1) {
      const line = lines[start + offset];
      const match = line.match(URGENCY_HEADER_PATTERN);
      if (match) return { line, value: match[1].toLowerCase() };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析结果文本头部的 urgency 行。剥掉开头空行后只看前 3 行；第一处匹配的
 * key 决定档位——值合法返回该档，值不合法归 fyi 且 raw 带整行 trim 原文；
 * 没有匹配行归 fyi 不带 raw。任何输入都不抛错，非字符串按无头处理。
 */
export function parseUrgencyHeader(text?: string): { urgency: CronUrgency; raw?: string } {
  const found = findUrgencyHeaderLine(text);
  if (!found) return { urgency: 'fyi' };
  return isCronUrgency(found.value)
    ? { urgency: found.value }
    : { urgency: 'fyi', raw: found.line.trim() };
}

/**
 * 结果文本是否「显式声明」了 can_wait/fyi 档（N-CRON-URGENCY-NOTIFY 通知门）。
 * 只认头部行真的写着这两个值：must_today、缺头、乱值头（urgency: maybe）、
 * 带多余内容的伪头都算未声明。乱值在 parseUrgencyHeader 里归 fyi 只是收件箱
 * 排序的兜底，不代表模型说了「不急」——通知门宁可多响一次，不吞今日必办。
 */
export function declaresCronUrgencyQuiet(text?: string): boolean {
  const found = findUrgencyHeaderLine(text);
  return found?.value === 'can_wait' || found?.value === 'fyi';
}
