// ============================================================================
// Deliverable Disk Check — 交付物落盘核对（issue #1998 产物幻觉闭环）
//
// 任务收尾时对「声称交付」的文件做落盘核对：存在且非空才认。声称来源两路：
//   1. declare_deliverables 写入的 declaredDeliverables（本 run 内声明的才算，
//      会话级旧声明不记本轮账——与 turnOutcomeStamp 的 run 域纪律同一把尺）；
//   2. 最终回复正文里的交付物声称（claim 动词 + 路径 token；词表与
//      postLaunchSignals 的 claimed_file_missing 信号同源，不新造平行口径）。
// 核对通过 → turn_outcome 可给 verified；不通过 → messageProcessor 回喂补一轮
// （有界，TURN_OUTCOME.MAX_DELIVERABLE_REPAIR_ROUNDS），仍缺在 final 如实说明。
// ============================================================================

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { TURN_OUTCOME } from '../../../shared/constants/agent';
import { type EvidenceRef } from '../../../shared/contract/evidence';
import type { Message } from '../../../shared/contract';
import type { DeclaredDeliverables } from './artifactState';
import { currentMessages } from './documentEvidenceBoundary';
import { readbackFileEvidence } from './fileEvidenceReadback';

/** 声称产物的动词；词表与 postLaunchSignals.CLAIM_VERB_PATTERN 同源，另补「已交付/交付了」。 */
const CLAIM_VERB_PATTERN = /已(?:写入|创建|生成|保存|落盘|交付)|写到|保存到|生成了|交付了|created|wrote|written to|saved to|generated/i;

/**
 * 引号/反引号包住的路径（容忍空格与中文——「已保存为 `周报 最终版.md`」这种形状只有
 * 引号形态抓得到，裸 token 正则被空格截断）。
 */
const QUOTED_PATH_PATTERN = /[`"'「『]([^`"'」』\n]{1,200}\.[A-Za-z0-9]{1,8})[`"'」』]/g;

/** 裸路径 token：字符集带 CJK（\w 不含汉字），仍要求有分隔符或 ~/./.. 开头才算路径。 */
const BARE_PATH_TOKEN_PATTERN = /(?:~|\.{1,2})?(?:[\w.\\/-]|[\u4e00-\u9fff])*[\w\u4e00-\u9fff-]\.[A-Za-z0-9]{1,8}/g;

export interface DeliverableClaim {
  /** 模型写的原始路径 */
  claimed: string;
  /** 对 workingDirectory resolve 后的绝对路径（NFC 归一化） */
  resolved: string;
  source: 'declared' | 'inferred';
}

export type DeliverableMissingKind = 'not_on_disk' | 'empty';

export interface DeliverableMissing {
  claim: DeliverableClaim;
  kind: DeliverableMissingKind;
}

export interface DeliverableDiskCheckResult {
  claims: DeliverableClaim[];
  /** 落盘核对通过的存在性证据（kind:'file'，小文件带 digest 记 read，超大文件记 candidate） */
  evidenceRefs: EvidenceRef[];
  missing: DeliverableMissing[];
}

/** NFC 归一化后的路径分段比对：macOS 盘上可能是 NFD，声称串一般是 NFC。 */
function normalizeNfc(value: string): string {
  return value.normalize('NFC');
}

function pathSegments(value: string): string[] {
  return normalizeNfc(value).split(/[\\/]+/).filter(Boolean);
}

/** 引用输入目录（资料/）的路径是「读取输入」不是交付物，不进核对。 */
function referencesInputMaterials(value: string): boolean {
  const segments = pathSegments(value);
  return TURN_OUTCOME.INPUT_MATERIALS_DIR_NAMES.some((name) => segments.includes(normalizeNfc(name)));
}

function looksLikeBarePath(token: string): boolean {
  return token.includes('/') || token.includes('\\') || token.startsWith('.') || token.startsWith('~');
}

/**
 * 从最终回复正文抽取「声称交付」的文件路径。
 * 先剥代码围栏（构建日志/命令回显里的 written to 不是交付声称），再按 claim 动词闸门：
 * 正文里没有声称动词就一条都不抽——罗列文件、引用输入都不算声称交付。
 */
export function extractClaimedDeliverablePaths(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  if (!CLAIM_VERB_PATTERN.test(prose)) return [];
  const found: string[] = [];
  for (const match of prose.matchAll(QUOTED_PATH_PATTERN)) {
    const candidate = match[1].trim();
    if (candidate && !candidate.includes('\n')) found.push(candidate);
  }
  for (const match of prose.matchAll(BARE_PATH_TOKEN_PATTERN)) {
    if (looksLikeBarePath(match[0])) found.push(match[0]);
  }
  return [...new Set(found.map(normalizeNfc))].filter((candidate) => !referencesInputMaterials(candidate));
}

function lastUserTimestamp(messages: readonly Message[]): number {
  return [...messages].reverse().find((message) => message.role === 'user')?.timestamp ?? 0;
}

/** 本 run 最终回复正文：最后一条可见 assistant 文本。 */
function finalReplyText(messages: readonly Message[]): string {
  const finalMessage = [...currentMessages(messages)]
    .reverse()
    .find((message) => message.role === 'assistant' && !message.isMeta && typeof message.content === 'string' && message.content.trim());
  return typeof finalMessage?.content === 'string' ? finalMessage.content : '';
}

/**
 * 收集本 run 的交付物声称。declared 只认本 run 内声明的（declaredAtMs 不早于最后一条
 * user 消息）：declareDeliverables 是会话级槽位，旧 run 的声明记到本轮头上，等于
 * turnOutcomeStamp 里 summary 会话级清单的同款旧账问题。
 */
export function collectDeliverableClaims(input: {
  messages: readonly Message[];
  workingDirectory: string;
  declaredDeliverables?: DeclaredDeliverables;
  /** 调用方手里有待收尾的正文（messageProcessor 落库前）时直接传，否则从 messages 里取最终回复 */
  finalText?: string;
}): DeliverableClaim[] {
  const claims: DeliverableClaim[] = [];
  const seen = new Set<string>();
  const push = (raw: string, source: DeliverableClaim['source']) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const resolved = normalizeNfc(isAbsolute(trimmed) ? trimmed : resolve(input.workingDirectory, trimmed));
    if (seen.has(resolved)) return;
    seen.add(resolved);
    claims.push({ claimed: trimmed, resolved, source });
  };

  const declared = input.declaredDeliverables;
  if (declared && declared.declaredAtMs >= lastUserTimestamp(input.messages)) {
    for (const artifact of declared.finalArtifacts) push(artifact, 'declared');
  }

  const text = input.finalText ?? finalReplyText(input.messages);
  for (const candidate of extractClaimedDeliverablePaths(text)) push(candidate, 'inferred');
  return claims;
}

/**
 * 落盘核对：文件存在且非空才认。macOS 盘上文件名可能是 NFD，声称串一般是 NFC，
 * 两种归一化形态都试；空的交付物（0 字节）与不存在同罪——「交付了空文件」也是幻觉。
 */
export function checkDeliverablesOnDisk(
  claims: readonly DeliverableClaim[],
  workingDirectory: string,
): DeliverableDiskCheckResult {
  const evidenceRefs: EvidenceRef[] = [];
  const missing: DeliverableMissing[] = [];
  const seenRefs = new Set<string>();

  for (const claim of claims) {
    const candidates = [...new Set([claim.resolved, claim.resolved.normalize('NFD')])];
    const hit = candidates.find((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!hit) {
      missing.push({ claim, kind: 'not_on_disk' });
      continue;
    }
    try {
      if (statSync(hit).size === 0) {
        missing.push({ claim, kind: 'empty' });
        continue;
      }
      const { evidence } = readbackFileEvidence(hit, workingDirectory, 'deliverable_disk_check');
      if (!seenRefs.has(evidence.ref)) {
        seenRefs.add(evidence.ref);
        evidenceRefs.push(evidence);
      }
    } catch {
      missing.push({ claim, kind: 'not_on_disk' });
    }
  }
  return { claims: [...claims], evidenceRefs, missing };
}

/** 给 evidenceProblems 的稳定 code 行。 */
export function formatDeliverableProblems(missing: readonly DeliverableMissing[]): string[] {
  return missing.map((item) => item.kind === 'empty'
    ? `DELIVERABLE_EMPTY: ${item.claim.resolved}`
    : `DELIVERABLE_NOT_ON_DISK: ${item.claim.resolved}`);
}

/** 回喂补轮的系统消息：缺漏带核验后的绝对路径，模型写错相对路径时能自纠。 */
export function buildDeliverableRepairPrompt(missing: readonly DeliverableMissing[]): string {
  const lines = missing.map((item, index) => {
    const reason = item.kind === 'empty' ? '文件是空的（0 字节）' : '文件不存在';
    return `${index + 1}. \`${item.claim.claimed}\`（核验路径 ${item.claim.resolved}）：${reason}`;
  });
  return [
    '<deliverable-disk-check>',
    '交付物落盘核对未通过：以下声明/声称的最终产物在磁盘上核对不到：',
    ...lines,
    '请二选一，然后重新收尾：',
    '- 真的把它们做出来：用工具写入/生成这些文件，写完后确认文件存在且非空；',
    '- 或者如实修改回复：不再声称已交付这些文件，并说明当前的实际状态。',
    '不要在没有真实落盘的情况下再次声称已交付。',
    '</deliverable-disk-check>',
  ].join('\n');
}

/** 补轮预算用尽后追加到 final 的如实说明（用户可见）。 */
export function appendUndeliveredNote(content: string, missing: readonly DeliverableMissing[]): string {
  const lines = missing.map((item) => {
    const reason = item.kind === 'empty' ? '文件为空' : '文件不存在';
    return `- ${item.claim.claimed}（${reason}）`;
  });
  return [
    content,
    '',
    '---',
    '⚠️ 交付物核对说明：以下提到的交付物在磁盘上核对不到，本轮实际未交付：',
    ...lines,
  ].join('\n');
}

export type DeliverableDiskCheckGateResult =
  | { action: 'pass'; content: string; missing: DeliverableMissing[] }
  | { action: 'repair'; prompt: string; missing: DeliverableMissing[] };

/**
 * 收尾闸（messageProcessor 落库前调用）：核对本 run 声称/声明的交付物。
 * 全过 → pass 原样放行；缺漏且补轮预算未尽 → action:'repair' 带修复提示（调用方
 * 注入并回喂模型补一轮）；预算用尽 → pass，但 content 已追加未交付说明。
 */
export function runDeliverableDiskCheckGate(input: {
  workingDirectory: string;
  messages: readonly Message[];
  declaredDeliverables?: DeclaredDeliverables;
  finalText: string;
  repairsUsed: number;
}): DeliverableDiskCheckGateResult {
  const check = checkDeliverablesOnDisk(
    collectDeliverableClaims({
      messages: input.messages,
      workingDirectory: input.workingDirectory,
      declaredDeliverables: input.declaredDeliverables,
      finalText: input.finalText,
    }),
    input.workingDirectory,
  );
  if (check.missing.length === 0) return { action: 'pass', content: input.finalText, missing: [] };
  if (input.repairsUsed < TURN_OUTCOME.MAX_DELIVERABLE_REPAIR_ROUNDS) {
    return { action: 'repair', prompt: buildDeliverableRepairPrompt(check.missing), missing: check.missing };
  }
  return { action: 'pass', content: appendUndeliveredNote(input.finalText, check.missing), missing: check.missing };
}
