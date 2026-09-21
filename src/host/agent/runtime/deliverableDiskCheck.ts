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
import os from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { TURN_OUTCOME } from '../../../shared/constants/agent';
import { makeEvidenceRef, type EvidenceRef } from '../../../shared/contract/evidence';
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

/**
 * 引号候选无路径形状时的兜底：扩展名须是真交付物类型（网页/文档/表格/演示/媒体/压缩包）。
 * 没有这条，`console.log`/`v2.1`/`Node.js`/`Vue.js` 这类引号标识符都会被抽成交付物声称
 * （ai-review #2007 Important）：误判缺失 → 白跑补轮、修复提示诱导模型在工作区造出
 * console.log 垃圾文件、预算用尽后 final 被追加错误的「未交付」说明。
 */
const DELIVERABLE_BARE_EXTENSIONS = new Set([
  'html', 'htm', 'md', 'txt', 'csv', 'pdf', 'json', 'zip', 'ts',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
  'mp4', 'mov', 'webm', 'mp3', 'wav', 'pptx', 'docx', 'xlsx',
]);

/** 删除/改写语境的子句不抽交付物——「已删除旧的 `x.ts`」里的路径不该被勒令复活。 */
const DELETION_CLAUSE_PATTERN = /删除|移除|删掉|重命名|deleted?|removed?|renamed?/i;

/** 子句边界：声称动词的管辖范围到句/逗号为止，不能按全文闸（一句「已创建」不该给整段贴标签）。 */
const CLAUSE_BOUNDARY = /[。！？；!?\n，,、；;]/;

export interface DeliverableClaim {
  /** 模型写的原始路径 */
  claimed: string;
  /** 对 workingDirectory resolve 后的绝对路径（NFC 归一化） */
  resolved: string;
  source: 'declared' | 'inferred';
}

type DeliverableMissingKind = 'not_on_disk' | 'empty';

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

/** Windows 盘符绝对路径前缀——裸 token 正则不含 ':'，先整段摘出来保住盘符（第六轮 Nit）。 */
const WINDOWS_DRIVE_PATH_PATTERN = /[A-Za-z]:[\\/][\w.\\/\u4e00-\u9fff -]*[\w\u4e00-\u9fff-]\.[A-Za-z0-9]{1,8}/g;

/**
 * 从最终回复正文抽取「声称交付」的文件路径。
 * 先剥 URL 与 host:port 链接（以扩展名结尾的链接不是本地交付物，抽出来只会误判
 * not_on_disk）和闭合代码围栏（构建日志/命令回显里的 written to 不是交付声称；
 * 未闭合围栏不剥，免得一路吞到正文结尾把后面的真声称漏掉），再按**子句**闸：
 * 只有含声称动词、且非删除/改写语境的子句才抽——全文闸会让一句「已创建」把
 * 整段里的 `console.log`/`v2.1` 都贴成交付物（ai-review #2007 Important）。
 */
function extractClaimedDeliverablePaths(text: string): string[] {
  const prose = text
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, ' ')
    // host:port 链接（localhost:5173/index.html）；要字母打头，10:30 这种时间形状不吃。
    .replace(/[a-zA-Z][\w.-]*:\d+\S*/g, ' ')
    .replace(/```[\s\S]*?```/g, '\n');
  const found: string[] = [];
  for (const clause of prose.split(CLAUSE_BOUNDARY)) {
    if (!CLAIM_VERB_PATTERN.test(clause) || DELETION_CLAUSE_PATTERN.test(clause)) continue;
    const windowsPaths: string[] = [];
    const clauseWithoutDrivePaths = clause.replace(WINDOWS_DRIVE_PATH_PATTERN, (match) => {
      windowsPaths.push(match);
      return ' ';
    });
    found.push(...windowsPaths);
    for (const match of clauseWithoutDrivePaths.matchAll(QUOTED_PATH_PATTERN)) {
      const candidate = match[1].trim();
      if (!candidate || candidate.includes('\n')) continue;
      const extension = candidate.slice(candidate.lastIndexOf('.') + 1).toLowerCase();
      if (looksLikeBarePath(candidate) || DELIVERABLE_BARE_EXTENSIONS.has(extension)) found.push(candidate);
    }
    for (const match of clauseWithoutDrivePaths.matchAll(BARE_PATH_TOKEN_PATTERN)) {
      // `//host/path` 是 URL 剥剩的协议相对形态，不是本地路径。
      if (match[0].startsWith('//')) continue;
      if (looksLikeBarePath(match[0])) found.push(match[0]);
    }
  }
  return [...new Set(found.map(normalizeNfc))].filter((candidate) => !referencesInputMaterials(candidate));
}

function lastUserTimestamp(messages: readonly Message[]): number {
  return [...messages].reverse().find((message) => message.role === 'user')?.timestamp ?? 0;
}

/** 与 postLaunchSignals.expandUserPath 同口径展开 ~——模型写 ~/Desktop/x.md 并声称时，不展开会误判 not_on_disk。 */
function expandUserPath(raw: string): string {
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return join(os.homedir(), raw.slice(2));
  return raw;
}

/**
 * 声称路径归一化（~ 展开 + 相对 resolve + NFC）。turnOutcomeStamp 的「本 run 真碰过」
 * 文件集合用同一把尺，否则同一文件以 ~/... 或 NFD/NFC 两种形态出现时，
 * 落盘核对通过但 claimsDeliveredThisRun 为假，误记 self_claimed（ai-review #2007 Nit）。
 */
export function normalizeDeliverablePath(raw: string, workingDirectory: string): string {
  const expanded = expandUserPath(raw.trim());
  return normalizeNfc(isAbsolute(expanded) ? expanded : resolve(workingDirectory, expanded));
}

/** 本 run 最终回复正文：最后一条可见 assistant 文本。 */
function finalReplyText(messages: readonly Message[]): string {
  const finalMessage = [...currentMessages(messages)]
    .reverse()
    .find((message) => message.role === 'assistant' && !message.isMeta && typeof message.content === 'string' && message.content.trim());
  return typeof finalMessage?.content === 'string' ? finalMessage.content : '';
}

/**
 * 本 run 成功工具结果报出的路径的 basename → 绝对路径映射。
 * 「已创建 `x.ts`」这种无分隔符声称，真实文件常在子目录（src/sub/x.ts）——只按
 * workingDirectory 根 resolve 会误判 not_on_disk，诱导模型在根目录造重复/空文件
 * （ai-review #2007 第四轮 Important）。先按 basename 对到本 run 真写出的文件。
 * bash/脚本产出没有 outputPath 可报，只进 nudgeManager 修改账（turnOutcomeStamp 同口径）。
 */
function runTouchedBasenames(
  messages: readonly Message[],
  workingDirectory: string,
  nudgeManager?: { getModifiedFilesSince(timestamp: number): string[] },
): Map<string, string> {
  const map = new Map<string, string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const resolved = normalizeDeliverablePath(value, workingDirectory);
    // 两种分隔符都切：win32 上 resolve 产出反斜杠路径，split('/') 取到的是整条路径，
    // 裸文件名声称永远对不上本 run 真写出的子目录文件（ai-review #2007 第六轮 Important）。
    const basename = resolved.split(/[\\/]/).pop();
    if (basename && !map.has(basename)) map.set(basename, resolved);
  };
  for (const message of currentMessages(messages)) {
    for (const result of message.toolResults ?? []) {
      if (!result.success) continue;
      if (Array.isArray(result.metadata?.changedFiles)) result.metadata.changedFiles.forEach(add);
      add(result.outputPath);
      add(result.metadata?.outputPath);
    }
  }
  // 防御：DeepPartial mock 里这个方法可能缺（messageProcessor 各测试文件的局部 mock）。
  if (typeof nudgeManager?.getModifiedFilesSince === 'function') {
    nudgeManager.getModifiedFilesSince(lastUserTimestamp(messages)).forEach(add);
  }
  return map;
}

/** 写入/产出类工具名——纯问答 run 没有这些调用，正文里的「会保存到 `out.csv`」只是讲解不是声称。 */
const PRODUCING_TOOL_PATTERN = /^(write|write_file|edit|edit_file|append|append_file|multiedit|bash|notebookedit)$/i;

/**
 * 本 run 是否有产出类动作。两条线任一：成功配对的写入族工具调用（Write/Edit/Bash 等）；
 * 或任一成功工具结果报了 outputPath/changedFiles——PPT/设计/图片/音视频等产物生成
 * 工具不靠写入族名字，靠结果元数据报产出（ai-review #2007 第六轮 Nit）。
 * 推断声称只在这种 run 里核对：动词表里的「保存到/写到/saved to/written to」可出现在
 * 假设/讲解语境，纯问答 run 的示例文件名不该触发补轮、更不该诱导模型造出未请求的文件
 * （ai-review #2007 第五轮 Important）。
 */
function runHasProducingActivity(messages: readonly Message[]): boolean {
  const active = currentMessages(messages);
  const succeeded = new Set(
    active.flatMap((message) => (message.toolResults ?? []).filter((result) => result.success).map((result) => result.toolCallId)),
  );
  if (active.some((message) =>
    (message.toolCalls ?? []).some((call) => succeeded.has(call.id) && PRODUCING_TOOL_PATTERN.test(call.name)))) return true;
  return active.some((message) =>
    (message.toolResults ?? []).some((result) => result.success
      && (typeof result.outputPath === 'string'
        || typeof result.metadata?.outputPath === 'string'
        || (Array.isArray(result.metadata?.changedFiles) && result.metadata.changedFiles.length > 0))));
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
  /** bash/脚本产出的修改账（runTouchedBasenames 的补充来源） */
  nudgeManager?: { getModifiedFilesSince(timestamp: number): string[] };
}): DeliverableClaim[] {
  const claims: DeliverableClaim[] = [];
  const seen = new Set<string>();
  const basenames = runTouchedBasenames(input.messages, input.workingDirectory, input.nudgeManager);
  const push = (raw: string, source: DeliverableClaim['source']) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // 无分隔符的裸文件名：先对到本 run 真写出的同名文件，对不上才按工作目录根 resolve。
    const resolved = !trimmed.includes('/') && !trimmed.includes('\\') && !trimmed.startsWith('~')
      ? basenames.get(normalizeNfc(trimmed)) ?? normalizeDeliverablePath(trimmed, input.workingDirectory)
      : normalizeDeliverablePath(trimmed, input.workingDirectory);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    claims.push({ claimed: trimmed, resolved, source });
  };

  const declared = input.declaredDeliverables;
  if (declared && declared.declaredAtMs >= lastUserTimestamp(input.messages)) {
    for (const artifact of declared.finalArtifacts) push(artifact, 'declared');
  }

  if (runHasProducingActivity(input.messages)) {
    const text = input.finalText ?? finalReplyText(input.messages);
    for (const candidate of extractClaimedDeliverablePaths(text)) push(candidate, 'inferred');
  }
  return claims;
}

/**
 * 落盘核对：文件存在且非空才认。macOS 盘上文件名可能是 NFD，声称串一般是 NFC，
 * 两种归一化形态都试；空的交付物（0 字节）与不存在同罪——「交付了空文件」也是幻觉。
 * IO 有界（ai-review #2007 Important）：最多处理 TURN_OUTCOME.MAX_DELIVERABLE_CLAIMS
 * 条声称；回读总字节超过 TURN_OUTCOME.MAX_DELIVERABLE_READBACK_BYTES 后降级为 stat
 * 存在性检查（candidate 证据，无 digest）——幻觉拦截不降级，回读哈希降级。
 */
export function checkDeliverablesOnDisk(
  claims: readonly DeliverableClaim[],
  workingDirectory: string,
): DeliverableDiskCheckResult {
  const evidenceRefs: EvidenceRef[] = [];
  const missing: DeliverableMissing[] = [];
  const seenRefs = new Set<string>();
  let readbackBytes = 0;

  for (const claim of claims.slice(0, TURN_OUTCOME.MAX_DELIVERABLE_CLAIMS)) {
    const candidates = [...new Set([claim.resolved, claim.resolved.normalize('NFD')])];
    const stat = candidates.map((candidate) => {
      try {
        return { hit: candidate, stat: statSync(candidate) };
      } catch {
        return undefined;
      }
    }).find((entry) => entry?.stat.isFile());
    if (!stat) {
      missing.push({ claim, kind: 'not_on_disk' });
      continue;
    }
    if (stat.stat.size === 0) {
      missing.push({ claim, kind: 'empty' });
      continue;
    }
    if (readbackBytes >= TURN_OUTCOME.MAX_DELIVERABLE_READBACK_BYTES) {
      evidenceRefs.push(makeEvidenceRef({ kind: 'file', ref: stat.hit, source: 'deliverable_disk_check', state: 'candidate' }));
      continue;
    }
    try {
      const { evidence } = readbackFileEvidence(stat.hit, workingDirectory, 'deliverable_disk_check');
      readbackBytes += Math.min(stat.stat.size, TURN_OUTCOME.MAX_DELIVERABLE_READBACK_BYTES - readbackBytes);
      if (!seenRefs.has(evidence.ref)) {
        seenRefs.add(evidence.ref);
        evidenceRefs.push(evidence);
      }
    } catch {
      missing.push({ claim, kind: 'not_on_disk' });
    }
  }
  return { claims: claims.slice(0, TURN_OUTCOME.MAX_DELIVERABLE_CLAIMS), evidenceRefs, missing };
}

/** 给 evidenceProblems 的稳定 code 行。 */
export function formatDeliverableProblems(missing: readonly DeliverableMissing[]): string[] {
  return missing.map((item) => item.kind === 'empty'
    ? `DELIVERABLE_EMPTY: ${item.claim.resolved}`
    : `DELIVERABLE_NOT_ON_DISK: ${item.claim.resolved}`);
}

/** 回喂补轮的系统消息：缺漏带核验后的绝对路径，模型写错相对路径时能自纠。 */
function buildDeliverableRepairPrompt(missing: readonly DeliverableMissing[]): string {
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
function appendUndeliveredNote(content: string, missing: readonly DeliverableMissing[]): string {
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
  nudgeManager?: { getModifiedFilesSince(timestamp: number): string[] };
}): DeliverableDiskCheckGateResult {
  const check = checkDeliverablesOnDisk(
    collectDeliverableClaims({
      messages: input.messages,
      workingDirectory: input.workingDirectory,
      declaredDeliverables: input.declaredDeliverables,
      finalText: input.finalText,
      nudgeManager: input.nudgeManager,
    }),
    input.workingDirectory,
  );
  if (check.missing.length === 0) return { action: 'pass', content: input.finalText, missing: [] };
  if (input.repairsUsed < TURN_OUTCOME.MAX_DELIVERABLE_REPAIR_ROUNDS) {
    return { action: 'repair', prompt: buildDeliverableRepairPrompt(check.missing), missing: check.missing };
  }
  return { action: 'pass', content: appendUndeliveredNote(input.finalText, check.missing), missing: check.missing };
}
