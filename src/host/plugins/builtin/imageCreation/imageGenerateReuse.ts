// ============================================================================
// 生成结果复用账本（N-MEDIA-GEN-IDEMPOTENT-RETRY）
// ============================================================================
// image_generate 是付费调用。崩溃恢复 / 自动重试会让模型在**新的** toolCallId 下
// 重复发出一模一样的参数，而上一张图已经落盘——按旧路径只能再掏一次钱。
// 这里给"同 session + 同参数"的调用配一本工作区内的 JSON 账本（无 DB schema 变更），
// 让重试找到并复用已落盘的产物。
//
// 复用判定规则（owner 决策 2026-10-09，option A：按 session + 参数判定）：
// 调用开始时按 (toolName, sessionId, fingerprint) 查账本，一条已保存产物**仅当**同时满足
// 下面三条才复用：
//   (a) 产物文件仍在磁盘上，且大小与记账时一致（防半写 / 被改动 / 被删除）；
//   (b) 产出它的那次调用**没有把结果送达循环**，二者满足其一：
//       - 本次 ctx.currentToolCallId 与账目记录的 toolCallId 相同（同一次调用的崩溃重放）；
//       - 或按该 toolCallId 直查工具执行事件账本（窗口无关）查不到"已送达"的 complete
//         事件——具体指 status 为 success / error 的 complete（结果或错误已被循环看到）；
//         status 'recovered' 是崩溃后 acknowledgeRecovery 的行政收口，模型从未看到
//         真实结果，**不算**已送达。
//   (c) 账目里的 absolutePath 落在工作区内（workingDir，或 workspaceScope 的可写根）。
//       账本 JSON 是模型可写的工作区文件，一条指路工作区外的账目（如 ~/.ssh/id_rsa）
//       若被复用会把任意文件读进来注册成 artifact——必须与 reference/output 的
//       范围闸对称（返修 r1 安全项）。
// 若上一次调用已 complete（模型看到了结果），完全相同的参数就是一次明确的
// "再来一张 / 重新生成"，必须照常出新图（新路径、正常计费）。
//
// 写账时机：文件完整写盘（fs.writeFileSync 之后）才记/更新账目，半写产物永远不会
// 被复用；批量按 prompt 粒度记账，崩溃在批次中途时已保存的条目仍可复用。
//
// 账本刻意做成工具无关（toolName + fingerprint 作为键，文件操作全部参数化）。
// image_generate 与 video_generate 共用这一本账和同一套 (a)(b)(c) 规则。
// 账本读写全部 fail-safe：任何异常都不阻断正常生成（宁可重新计费，不可坏一次出图）。

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ToolContext } from '../../../protocol/tools';
import { getDatabase } from '../../../services/core/databaseService';
import { isPathWithinRoot, resolveWorkspacePath } from '../../../runtime/workspaceScope';

const LEDGER_FILENAME = 'generation-ledger.json';

/** 复用交付写进 output 的明示行。image_generate 与 video_generate 共用，措辞不许漂移。 */
export const REUSED_RESULT_LINE = '复用上次生成结果 (reused previous result, no new charge)';

/** 账本条目上限：超了就按 updatedAt 淘汰最旧的，防 JSON 无界增长。 */
const LEDGER_MAX_ENTRIES = 100;

/** 一条已落盘的生成产物（按 prompt 粒度）。 */
export interface GenerationLedgerSavedOutput {
  /** 批次内 1-based 的 prompt 序号 */
  index: number;
  /** 落盘绝对路径 */
  absolutePath: string;
  /** 写盘时的字节大小（复用前核对） */
  bytes: number;
  /** 实际出图模型（复用时回填 meta.model，不谎报） */
  actualModel: string;
}

interface GenerationLedgerEntry {
  toolName: string;
  fingerprint: string;
  sessionId: string;
  /** 产出该批产物的调用 id；无 toolCallId 上下文时为 null */
  toolCallId: string | null;
  updatedAt: number;
  saved: GenerationLedgerSavedOutput[];
}

interface GenerationLedgerFile {
  version: 1;
  entries: GenerationLedgerEntry[];
}

/** 工具执行事件账本里复用判定需要的最小结构（ToolExecutionEventRecord 的结构子集）。 */
interface ToolExecutionEventLike {
  executionId: string;
  phase: string;
  status: string | null;
  toolCallId: string | null;
}

/** image_generate 指纹入参：与 ValidatedImageGenerateParams 同形（结构化，避免循环 import）。 */
export interface ImageGenerateFingerprintParams {
  prompts: string[];
  referencePaths: string[];
  expandPrompt: boolean;
  aspectRatio: string;
  outputFilePath?: string;
  style?: string;
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(absolutePath: string): string {
  try {
    return sha256Hex(fs.readFileSync(absolutePath));
  } catch {
    // 校验刚 stat 过，这里只是竞态兜底：读不到就让它指纹不匹配（不复用），不抛。
    return 'unreadable';
  }
}

/**
 * 对"会影响产出"的参数做稳定归一后取 sha256：
 * prompts（保持顺序）、aspect_ratio、style、expand_prompt、output_file_path、
 * 参考图路径 + 参考图内容哈希。默认路径（未传 output_file_path）的时间戳派生路径
 * 不进指纹——重试时正是靠账本找回上一次的时间戳路径。
 */
export function computeImageGenerateFingerprint(params: ImageGenerateFingerprintParams): string {
  const normalized = {
    prompts: params.prompts,
    aspectRatio: params.aspectRatio,
    style: params.style ?? null,
    expandPrompt: params.expandPrompt === true,
    outputFilePath: params.outputFilePath ?? null,
    reference: params.referencePaths[0]
      ? { path: params.referencePaths[0], contentSha256: sha256File(params.referencePaths[0]) }
      : null,
  };
  return sha256Hex(JSON.stringify(normalized));
}

function isValidSaved(saved: unknown): saved is GenerationLedgerSavedOutput {
  if (!saved || typeof saved !== 'object') return false;
  const candidate = saved as Partial<GenerationLedgerSavedOutput>;
  return typeof candidate.index === 'number'
    && typeof candidate.absolutePath === 'string'
    && typeof candidate.bytes === 'number'
    && typeof candidate.actualModel === 'string';
}

function readLedger(ledgerDir: string): GenerationLedgerFile {
  try {
    const raw = fs.readFileSync(path.join(ledgerDir, LEDGER_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GenerationLedgerFile>;
    if (parsed && Array.isArray(parsed.entries)) {
      return {
        version: 1,
        entries: parsed.entries.filter((entry): entry is GenerationLedgerEntry => (
          Boolean(entry)
          && typeof entry.toolName === 'string'
          && typeof entry.fingerprint === 'string'
          && typeof entry.sessionId === 'string'
          && Array.isArray(entry.saved)
          && entry.saved.every(isValidSaved)
        )),
      };
    }
  } catch {
    // 账本缺失 / 损坏 → 从空账本重新开始（只丢复用机会，不影响生成）。
  }
  return { version: 1, entries: [] };
}

function writeLedger(ledgerDir: string, ledger: GenerationLedgerFile): void {
  const target = path.join(ledgerDir, LEDGER_FILENAME);
  const staged = target + '.tmp';
  if (!fs.existsSync(ledgerDir)) fs.mkdirSync(ledgerDir, { recursive: true });
  // 先写临时文件再原子 rename：撕裂写只会丢账本，不会留下半截 JSON。
  fs.writeFileSync(staged, JSON.stringify(ledger));
  fs.renameSync(staged, target);
}

function findEntry(ledger: GenerationLedgerFile, input: {
  toolName: string;
  sessionId: string;
  fingerprint: string;
}): GenerationLedgerEntry | undefined {
  return ledger.entries.find((entry) => (
    entry.toolName === input.toolName
    && entry.sessionId === input.sessionId
    && entry.fingerprint === input.fingerprint
  ));
}

/**
 * 产出该账目的调用是否已把结果送达循环（判定规则 (b) 的第二支）。
 * 按 toolCallId 直查（getToolExecutionsBySessionAndToolCallId）：begin 行带
 * toolCallId、complete 行只带 executionId（仓储契约），查询在 SQL 里按
 * toolCallId 命中 begin 再带回同 executionId 的 complete，**与会话长度无关**——
 * 会话窗口查询（ASC+LIMIT）在长会话里只剩最旧事件，近期调用的 begin 会被截出
 * 窗口，把"已送达"错判成"未送达"（返修 r1）。
 * 查询本身失败（库未开 / 库锁 / 表损坏）按"已送达"处理——fail-safe 落回正常生成，
 * 不让异常态悄悄改写计费语义。这条依赖服务侧契约：getToolExecutionsBySessionAndToolCallId
 * 对"无法判定"**显式抛错**而非吞成空数组（返修 r2——服务侧吞错时本函数的 catch 是
 * 死代码，异常态会全部漏进"未送达 → 复用"支）。空结果（连 begin 都没记到）按"未送达"
 * 处理：begin 在工具调用的最前面落库，查不到说明该调用从未真正开始执行。
 */
function priorCallDeliveredResult(sessionId: string, toolCallId: string | null): boolean {
  if (toolCallId === null) return false;
  let events: ToolExecutionEventLike[];
  try {
    events = getDatabase().getToolExecutionsBySessionAndToolCallId(sessionId, toolCallId);
  } catch {
    return true;
  }
  return events.some((event) => event.phase === 'complete' && event.status !== 'recovered');
}

/**
 * 账目里的绝对路径是否落在工作区内（判定规则 (c)，返修 r1 安全项）。
 * 与写侧闸（imageGenerate 的 outputPathOutsideWorkspace）同形：必须在 workingDir
 * 内，或在 workspaceScope 的可写根内。账本是模型可写的工作区文件，工作区外的
 * 路径一律不认——防"伪造账目 → 复用链路把任意文件读进来注册成 artifact"。
 */
function ledgerPathInsideWorkspace(
  absolutePath: string,
  ctx: Pick<ToolContext, 'workingDir' | 'workspaceScope'>,
): boolean {
  if (isPathWithinRoot(absolutePath, ctx.workingDir)) return true;
  if (!ctx.workspaceScope) return false;
  return resolveWorkspacePath(ctx.workspaceScope, absolutePath, 'read_write') !== undefined;
}

function savedFileIntact(saved: GenerationLedgerSavedOutput): boolean {
  try {
    const stat = fs.statSync(saved.absolutePath);
    return stat.isFile() && stat.size === saved.bytes;
  } catch {
    return false;
  }
}

/**
 * 调用开始时查可复用产物。返回通过 (a)(b)(c) 三关的条目（可少于账目里的全部）；
 * 任何异常都返回空数组（正常生成，绝不因账本阻断付费链路之外的行为）。
 */
export function lookupReusableGenerationOutputs(input: {
  ctx: Pick<ToolContext, 'sessionId' | 'currentToolCallId' | 'workingDir' | 'workspaceScope'>;
  ledgerDir: string;
  toolName: string;
  fingerprint: string;
}): GenerationLedgerSavedOutput[] {
  try {
    const entry = findEntry(readLedger(input.ledgerDir), {
      toolName: input.toolName,
      sessionId: input.ctx.sessionId,
      fingerprint: input.fingerprint,
    });
    if (!entry) return [];
    const currentToolCallId = input.ctx.currentToolCallId ?? null;
    if (
      entry.toolCallId !== currentToolCallId
      && priorCallDeliveredResult(input.ctx.sessionId, entry.toolCallId)
    ) {
      return [];
    }
    return entry.saved.filter((saved) => (
      ledgerPathInsideWorkspace(saved.absolutePath, input.ctx) && savedFileIntact(saved)
    ));
  } catch {
    return [];
  }
}

/**
 * 一个 prompt 的产物完整落盘后记账（upsert 到 (toolName, sessionId, fingerprint) 条目，
 * 按 index 覆盖）。复用交付也走这里：把账目归属更新为本次调用，这样本次调用完成后，
 * 再来一次相同参数的调用就是"再来一张"而不是无限复用。
 */
export function recordGenerationSavedOutput(input: {
  ctx: Pick<ToolContext, 'sessionId' | 'currentToolCallId'>;
  ledgerDir: string;
  toolName: string;
  fingerprint: string;
  saved: GenerationLedgerSavedOutput;
  now?: number;
}): void {
  try {
    const ledger = readLedger(input.ledgerDir);
    const entry = findEntry(ledger, {
      toolName: input.toolName,
      sessionId: input.ctx.sessionId,
      fingerprint: input.fingerprint,
    });
    const toolCallId = input.ctx.currentToolCallId ?? null;
    const updatedAt = input.now ?? Date.now();
    if (!entry) {
      ledger.entries.push({
        toolName: input.toolName,
        fingerprint: input.fingerprint,
        sessionId: input.ctx.sessionId,
        toolCallId,
        updatedAt,
        saved: [input.saved],
      });
    } else {
      entry.toolCallId = toolCallId;
      entry.updatedAt = updatedAt;
      const existing = entry.saved.find((saved) => saved.index === input.saved.index);
      if (existing) Object.assign(existing, input.saved);
      else entry.saved.push(input.saved);
      entry.saved.sort((a, b) => a.index - b.index);
    }
    if (ledger.entries.length > LEDGER_MAX_ENTRIES) {
      ledger.entries.sort((a, b) => a.updatedAt - b.updatedAt);
      ledger.entries = ledger.entries.slice(-LEDGER_MAX_ENTRIES);
    }
    writeLedger(input.ledgerDir, ledger);
  } catch {
    // 记账失败只丢复用机会，不影响本次生成结果。
  }
}
