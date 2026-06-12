// ============================================================================
// DistillService — 重复工作流蒸馏六阶段编排器（roadmap 3.2）
// ============================================================================
// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) — agent/prompt/distill.txt
// 的六阶段语义（盘点现有资产→扫记忆找重复信号→频率验证→打分→按最小形式产出→注册）。
//
// 与上游的关键差异（有意为之，吸取本仓库两轮对抗审计教训）：
// - 上游是纯 prompt 驱动（LLM 自觉执行频率门），本实现把硬门全部代码化：
//   频率验证（≥DISTILL.MIN_OCCURRENCES 的 distinct FTS 证据 + 相关性校验，
//   复用 dream 审计加固后的 supportsCandidate, fa3aaf326）、字段格式/长度校验、
//   candidateId 引用校验、重名拒绝，全部发生在 service 层。
// - LLM 只出现在 Phase 5（结构化提案生成，注入式接口），从头到尾不持有
//   文件写入工具、不控制任何路径。
// - 落盘由注入的确定性 emitter 执行（command 归 services/commands 域）。
// ============================================================================

import { createHash } from 'crypto';
import type { Message } from '../../../shared/contract';
import { DISTILL } from '../../../shared/constants';
import {
  TranscriptHistoryService,
  type TranscriptHistoryDatabase,
} from '../history/transcriptHistoryService';
import { supportsCandidate, type DreamCandidate } from '../memory/dreamMemoryService';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface SessionLike {
  id: string;
  title?: string;
  workingDirectory?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DistillDatabase extends TranscriptHistoryDatabase {
  listSessions(limit?: number, offset?: number, includeArchived?: boolean): SessionLike[];
  getRecentMessages(sessionId: string, count: number): Message[];
}

export interface DistillSignal {
  id: string;
  /** 一行工作流描述 */
  title: string;
  /** 信号原文（已截断） */
  content: string;
  /** FTS 验证查询 */
  queries: string[];
  sessionId?: string | null;
  sourceKind: 'message' | 'memory';
}

export interface DistillSignalExtractorInput {
  sessions: SessionLike[];
  messagesBySession: Map<string, Message[]>;
  now: number;
}

export type DistillSignalExtractor = (
  input: DistillSignalExtractorInput,
) => Promise<DistillSignal[]> | DistillSignal[];

export interface DistillEvidence {
  sessionId: string;
  messageId: string;
  snippet: string;
  timestamp: number;
}

export interface DistillVerifiedCandidate {
  candidateId: string;
  signal: DistillSignal;
  /** distinct 支持消息数（频率硬门口径） */
  frequency: number;
  /** distinct 支持 session 数 */
  sessionBreadth: number;
  lastSeenAt: number;
  /** [0,1]，仅用于排序入围，不是第二道门 */
  score: number;
  evidence: DistillEvidence[];
}

export type DistillSignalSkipReason =
  | 'empty-signal'
  | 'covered-by-existing'
  | 'no-fts-evidence'
  | 'frequency-below-threshold';

export interface DistillSkippedSignal {
  signalId: string;
  reason: DistillSignalSkipReason;
  detail?: string;
}

export interface DistillAssetInventory {
  commands: Array<{ name: string; description?: string }>;
  skills: Array<{ name: string; description?: string }>;
  agents: string[];
  /** 被用户拒绝过的草稿名（skillDraftQueue rejected ledger），不再重复提案 */
  rejectedNames: string[];
}

export type DistillProposalForm = 'command' | 'skill' | 'subagent-recommendation';

export interface DistillProposal {
  /** 必须引用入围候选的 candidateId */
  candidateId: string;
  form: DistillProposalForm;
  name: string;
  description: string;
  /** command 模板正文 或 skill 内容 */
  body: string;
  argumentHint?: string;
}

export type DistillProposalGenerator = (
  candidates: DistillVerifiedCandidate[],
  context: { inventory: DistillAssetInventory; mode: DistillRunMode },
) => Promise<DistillProposal[]> | DistillProposal[];

export interface DistillEmitResult {
  location: string;
  /** false = 草稿（人不在场，产出物一律不激活） */
  activated: boolean;
}

export interface DistillEmitters {
  emitCommand(proposal: DistillProposal, opts: { draft: boolean }): Promise<DistillEmitResult>;
  emitSkill(proposal: DistillProposal, opts: { draft: boolean }): Promise<DistillEmitResult>;
}

export type DistillProposalSkipReason =
  | 'unknown-candidate'
  | 'invalid-form'
  | 'invalid-name'
  | 'invalid-description'
  | 'empty-body'
  | 'body-too-long'
  | 'name-collision'
  | 'emit-failed';

export interface DistillSkippedProposal {
  candidateId: string;
  name: string;
  reason: DistillProposalSkipReason;
  detail?: string;
}

export interface DistillEmittedAsset {
  form: 'command' | 'skill';
  name: string;
  description: string;
  location: string;
  activated: boolean;
  candidateId: string;
}

export type DistillRunMode = 'manual' | 'auto';

export interface DistillRunReport {
  mode: DistillRunMode;
  phase: 'completed' | 'nothing-to-distill';
  inventory: { commandCount: number; skillCount: number; agentCount: number };
  sessionsReviewed: number;
  signalsDiscovered: number;
  verified: DistillVerifiedCandidate[];
  skippedSignals: DistillSkippedSignal[];
  proposals: DistillProposal[];
  emitted: DistillEmittedAsset[];
  skippedProposals: DistillSkippedProposal[];
  /** subagent 形态只出建议（不自动产出带工具授权的子代理定义） */
  recommendations: string[];
}

export interface DistillRunOptions {
  db: DistillDatabase;
  inventory: () => Promise<DistillAssetInventory>;
  proposalGenerator: DistillProposalGenerator;
  emitters: DistillEmitters;
  signalExtractor?: DistillSignalExtractor;
  mode?: DistillRunMode;
  projectPath?: string | null;
  now?: number;
  windowDays?: number;
  sessionLimit?: number;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const DEFAULT_SESSION_LIMIT = 50;
const DEFAULT_RECENT_MESSAGES = 30;
const NAME_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

function compact(value: string | null | undefined, limit: number): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function queryTokens(value: string): string[] {
  const ascii = value.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? [];
  const cjk = value.match(/[一-鿿]{2,}/g) ?? [];
  return Array.from(new Set([...ascii, ...cjk])).slice(0, 8);
}

function isRecentSession(session: SessionLike, windowStart: number): boolean {
  const updatedAt = Number(session.updatedAt || session.createdAt || 0);
  return updatedAt >= windowStart;
}

/** 窗口内无会话 → 空集（不降级全历史，对齐 dream 审计 A-M2 的语义） */
function pickSessions(
  sessions: SessionLike[],
  projectPath: string | null | undefined,
  windowStart: number,
): SessionLike[] {
  const scoped = projectPath
    ? sessions.filter((session) => !session.workingDirectory || session.workingDirectory === projectPath)
    : sessions;
  return scoped.filter((session) => isRecentSession(session, windowStart));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toDreamCandidate(signal: DistillSignal): DreamCandidate {
  return {
    id: signal.id,
    title: signal.title,
    summary: signal.title,
    content: signal.content,
  };
}

/** 信号 title 的全部 tokens 被同一现有资产（name+description）覆盖 → 已有资产管辖 */
function coveredByExisting(signal: DistillSignal, inventory: DistillAssetInventory): string | null {
  const tokens = queryTokens(signal.title);
  if (tokens.length === 0) return null;
  const assets = [
    ...inventory.commands.map((c) => ({ kind: 'command', name: c.name, text: `${c.name} ${c.description ?? ''}` })),
    ...inventory.skills.map((s) => ({ kind: 'skill', name: s.name, text: `${s.name} ${s.description ?? ''}` })),
  ];
  for (const asset of assets) {
    const haystack = normalizeText(asset.text);
    if (tokens.every((token) => haystack.includes(normalizeText(token)))) {
      return `${asset.kind}:${asset.name}`;
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Phase 2 默认信号提取器（确定性启发式；生产可注入更强实现）
// ----------------------------------------------------------------------------

const REPEAT_SIGNAL_PATTERN =
  /每次|每周|每天|定期|老规矩|像上次|跟之前一样|按惯例|又要|再帮我|every time|again|the usual|as usual|like last time|repeat/i;

export async function extractDistillSignalsFromRecentMessages(
  input: DistillSignalExtractorInput,
): Promise<DistillSignal[]> {
  const signals: DistillSignal[] = [];
  const seenTitles = new Set<string>();
  for (const session of input.sessions) {
    const messages = input.messagesBySession.get(session.id) || [];
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const text = compact(typeof msg.content === 'string' ? msg.content : '', DISTILL.SIGNAL_CONTENT_MAX_CHARS);
      if (text.length < 12 || !REPEAT_SIGNAL_PATTERN.test(text)) continue;
      const title = compact(text, 80);
      const normalizedTitle = normalizeText(title);
      if (seenTitles.has(normalizedTitle)) continue;
      seenTitles.add(normalizedTitle);
      const tokens = queryTokens(text);
      signals.push({
        id: `sig_${hashText(`${session.id}\n${msg.id}\n${text}`)}`,
        title,
        content: text,
        queries: [tokens.slice(0, 3).join(' '), tokens.slice(0, 5).join(' ')]
          .filter((query) => query.trim().length >= 3),
        sessionId: session.id,
        sourceKind: 'message',
      });
    }
  }
  return signals.slice(0, DISTILL.MAX_SIGNALS);
}

// ----------------------------------------------------------------------------
// Phase 3 频率硬门
// ----------------------------------------------------------------------------

async function verifySignalFrequency(
  signal: DistillSignal,
  history: TranscriptHistoryService,
): Promise<Omit<DistillVerifiedCandidate, 'candidateId' | 'score'> | null> {
  const supportingMessages = new Set<string>();
  const supportingSessions = new Set<string>();
  const evidence: DistillEvidence[] = [];
  let lastSeenAt = 0;
  const dreamCandidate = toDreamCandidate(signal);

  for (const query of signal.queries.slice(0, 5)) {
    const hits = await history.search(query, { limit: DISTILL.MAX_HITS_PER_QUERY });
    for (const hit of hits) {
      if (supportingMessages.has(hit.messageId)) continue;
      const around = await history.around(hit.messageId, { before: 2, after: 2 });
      // 相关性校验复用 dream 审计加固后的实现（fa3aaf326）：泛词命中不放行
      if (!supportsCandidate(dreamCandidate, hit, around)) continue;
      supportingMessages.add(hit.messageId);
      supportingSessions.add(hit.sessionId);
      lastSeenAt = Math.max(lastSeenAt, hit.timestamp);
      if (evidence.length < DISTILL.MAX_EVIDENCE_PER_CANDIDATE) {
        evidence.push({
          sessionId: hit.sessionId,
          messageId: hit.messageId,
          snippet: compact(hit.snippet, 300),
          timestamp: hit.timestamp,
        });
      }
    }
  }

  if (supportingMessages.size === 0) return null;
  return {
    signal,
    frequency: supportingMessages.size,
    sessionBreadth: supportingSessions.size,
    lastSeenAt,
    evidence,
  };
}

// ----------------------------------------------------------------------------
// Phase 4 打分（仅排序入围，频率门才是硬门）
// ----------------------------------------------------------------------------

function scoreCandidate(
  candidate: Omit<DistillVerifiedCandidate, 'candidateId' | 'score'>,
  now: number,
  windowMs: number,
): number {
  const freq = Math.min(candidate.frequency / 4, 1);
  const breadth = Math.min(candidate.sessionBreadth / 3, 1);
  const recency = clamp01(1 - (now - candidate.lastSeenAt) / windowMs);
  return clamp01(0.5 * freq + 0.3 * breadth + 0.2 * recency);
}

// ----------------------------------------------------------------------------
// Phase 6 提案校验（LLM 产出落盘前的最后一道代码门）
// ----------------------------------------------------------------------------

interface ProposalValidationResult {
  ok: boolean;
  reason?: DistillProposalSkipReason;
  detail?: string;
  sanitized?: DistillProposal;
}

function validateProposal(
  proposal: DistillProposal,
  verifiedIds: Set<string>,
  takenNames: Set<string>,
): ProposalValidationResult {
  if (!verifiedIds.has(proposal.candidateId)) {
    return { ok: false, reason: 'unknown-candidate', detail: proposal.candidateId };
  }
  if (!['command', 'skill', 'subagent-recommendation'].includes(proposal.form)) {
    return { ok: false, reason: 'invalid-form', detail: String(proposal.form) };
  }
  const name = (proposal.name || '').trim().toLowerCase();
  if (!name || name.length > DISTILL.NAME_MAX_LENGTH || !NAME_PATTERN.test(name)) {
    return { ok: false, reason: 'invalid-name', detail: proposal.name };
  }
  const description = compact(proposal.description, DISTILL.DESCRIPTION_MAX_LENGTH);
  if (!description) {
    return { ok: false, reason: 'invalid-description' };
  }
  const body = (proposal.body || '').trim();
  if (proposal.form !== 'subagent-recommendation') {
    if (!body) {
      return { ok: false, reason: 'empty-body' };
    }
    if (body.length > DISTILL.BODY_MAX_LENGTH) {
      return { ok: false, reason: 'body-too-long', detail: `${body.length} > ${DISTILL.BODY_MAX_LENGTH}` };
    }
    if (takenNames.has(name)) {
      return { ok: false, reason: 'name-collision', detail: name };
    }
  }
  return { ok: true, sanitized: { ...proposal, name, description, body } };
}

// ----------------------------------------------------------------------------
// runDistill — 六阶段编排
// ----------------------------------------------------------------------------

export async function runDistill(options: DistillRunOptions): Promise<DistillRunReport> {
  const now = options.now ?? Date.now();
  const mode: DistillRunMode = options.mode ?? 'manual';
  const windowDays = options.windowDays ?? DISTILL.WINDOW_DAYS;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const windowStart = now - windowMs;
  const history = new TranscriptHistoryService(options.db);

  // Phase 1 — 盘点现有资产
  const inventory = await options.inventory();
  const report: DistillRunReport = {
    mode,
    phase: 'completed',
    inventory: {
      commandCount: inventory.commands.length,
      skillCount: inventory.skills.length,
      agentCount: inventory.agents.length,
    },
    sessionsReviewed: 0,
    signalsDiscovered: 0,
    verified: [],
    skippedSignals: [],
    proposals: [],
    emitted: [],
    skippedProposals: [],
    recommendations: [],
  };

  const allSessions = options.db.listSessions(options.sessionLimit ?? DEFAULT_SESSION_LIMIT, 0, true);
  const sessions = pickSessions(allSessions, options.projectPath, windowStart);
  report.sessionsReviewed = sessions.length;
  if (sessions.length === 0) {
    report.phase = 'nothing-to-distill';
    return report;
  }

  // Phase 2 — 扫记忆/会话找重复信号
  const messagesBySession = new Map<string, Message[]>();
  for (const session of sessions) {
    messagesBySession.set(session.id, options.db.getRecentMessages(session.id, DEFAULT_RECENT_MESSAGES));
  }
  const extractor = options.signalExtractor ?? extractDistillSignalsFromRecentMessages;
  const signals = (await extractor({ sessions, messagesBySession, now })).slice(0, DISTILL.MAX_SIGNALS);
  report.signalsDiscovered = signals.length;

  // Phase 3 — 频率硬门 + Phase 4 — 打分
  const scored: DistillVerifiedCandidate[] = [];
  for (const signal of signals) {
    if (!signal.title.trim() || !signal.content.trim() || signal.queries.length === 0) {
      report.skippedSignals.push({ signalId: signal.id, reason: 'empty-signal' });
      continue;
    }
    const coveredBy = coveredByExisting(signal, inventory);
    if (coveredBy) {
      report.skippedSignals.push({ signalId: signal.id, reason: 'covered-by-existing', detail: coveredBy });
      continue;
    }
    const verified = await verifySignalFrequency(signal, history);
    if (!verified) {
      report.skippedSignals.push({ signalId: signal.id, reason: 'no-fts-evidence' });
      continue;
    }
    if (verified.frequency < DISTILL.MIN_OCCURRENCES) {
      report.skippedSignals.push({
        signalId: signal.id,
        reason: 'frequency-below-threshold',
        detail: `frequency=${verified.frequency} < ${DISTILL.MIN_OCCURRENCES}`,
      });
      continue;
    }
    scored.push({
      ...verified,
      candidateId: `cand_${hashText(`${signal.id}\n${signal.title}`)}`,
      score: scoreCandidate(verified, now, windowMs),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const shortlist = scored.slice(0, DISTILL.SHORTLIST_MAX);
  report.verified = shortlist;

  if (shortlist.length === 0) {
    return report;
  }

  // Phase 5 — LLM 结构化提案（注入式；LLM 不持有任何文件写入工具）
  const proposals = (await options.proposalGenerator(shortlist, { inventory, mode })).slice(
    0,
    DISTILL.MAX_PROPOSALS,
  );
  report.proposals = proposals;

  // Phase 6 — 校验 + 确定性落盘 + 注册
  const verifiedIds = new Set(shortlist.map((candidate) => candidate.candidateId));
  const takenNames = new Set<string>(
    [
      ...inventory.commands.map((c) => c.name),
      ...inventory.skills.map((s) => s.name),
      ...inventory.agents,
      ...inventory.rejectedNames,
    ].map((name) => name.trim().toLowerCase()),
  );

  for (const proposal of proposals) {
    const result = validateProposal(proposal, verifiedIds, takenNames);
    if (!result.ok || !result.sanitized) {
      report.skippedProposals.push({
        candidateId: proposal.candidateId,
        name: proposal.name,
        reason: result.reason ?? 'invalid-form',
        detail: result.detail,
      });
      continue;
    }
    const sanitized = result.sanitized;
    if (sanitized.form === 'subagent-recommendation') {
      report.recommendations.push(`${sanitized.name}: ${sanitized.description}`);
      continue;
    }
    try {
      const draft = mode === 'auto'; // 人不在场，产出物一律不激活（GAP-005 语义）
      const emitted =
        sanitized.form === 'command'
          ? await options.emitters.emitCommand(sanitized, { draft })
          : await options.emitters.emitSkill(sanitized, { draft });
      takenNames.add(sanitized.name);
      report.emitted.push({
        form: sanitized.form,
        name: sanitized.name,
        description: sanitized.description,
        location: emitted.location,
        activated: emitted.activated,
        candidateId: sanitized.candidateId,
      });
    } catch (error) {
      report.skippedProposals.push({
        candidateId: sanitized.candidateId,
        name: sanitized.name,
        reason: 'emit-failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

// ----------------------------------------------------------------------------
// 运行报告格式化（注入 skill 上下文块 / cron 执行结果）
// ----------------------------------------------------------------------------

export function formatDistillRunReport(report: DistillRunReport): string {
  const lines: string[] = [];
  lines.push(`# Distill 运行报告（${report.mode === 'auto' ? '自动' : '手动'}）`);
  lines.push('');
  lines.push(`## 阶段 1 盘点现有资产`);
  lines.push(
    `commands: ${report.inventory.commandCount} / skills: ${report.inventory.skillCount} / agents: ${report.inventory.agentCount}`,
  );
  lines.push(`## 阶段 2 扫描重复信号`);
  lines.push(`回看会话: ${report.sessionsReviewed}，发现信号: ${report.signalsDiscovered}`);
  lines.push(`## 阶段 3 频率验证（硬门 ≥${DISTILL.MIN_OCCURRENCES} 次）`);
  if (report.phase === 'nothing-to-distill') {
    lines.push('窗口内无可蒸馏内容（Nothing to distill）——这是合法的成功结果。');
    return lines.join('\n');
  }
  const rejected = report.skippedSignals
    .map((skip) => `- ${skip.signalId}: ${skip.reason}${skip.detail ? `（${skip.detail}）` : ''}`)
    .join('\n');
  lines.push(`通过: ${report.verified.length}，被拒: ${report.skippedSignals.length}`);
  if (rejected) lines.push(rejected);
  lines.push(`## 阶段 4 打分入围`);
  for (const candidate of report.verified) {
    lines.push(
      `- [${candidate.candidateId}] ${candidate.signal.title} | frequency=${candidate.frequency} sessions=${candidate.sessionBreadth} score=${candidate.score.toFixed(2)}`,
    );
  }
  lines.push(`## 阶段 5 结构化提案`);
  lines.push(`提案: ${report.proposals.length}，被校验拒绝: ${report.skippedProposals.length}`);
  for (const skip of report.skippedProposals) {
    lines.push(`- ✗ ${skip.name}: ${skip.reason}${skip.detail ? `（${skip.detail}）` : ''}`);
  }
  lines.push(`## 阶段 6 产出与注册`);
  if (report.emitted.length === 0) {
    lines.push('未产出资产（无满足硬门的提案）——合法结果，不为凑数而造资产。');
  }
  for (const asset of report.emitted) {
    lines.push(
      `- ✓ [${asset.form}] ${asset.name} → ${asset.location}${asset.activated ? '（已注册激活）' : '（草稿待确认，未激活）'}`,
    );
  }
  if (report.recommendations.length > 0) {
    lines.push(`## Subagent 建议（不自动产出，留人工决策）`);
    for (const recommendation of report.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }
  return lines.join('\n');
}
