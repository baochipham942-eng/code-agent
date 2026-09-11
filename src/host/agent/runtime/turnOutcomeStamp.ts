import { checkDocumentEvidenceClaims } from './documentEvidenceBoundary';
import { readbackFileEvidence } from './fileEvidenceReadback';
import type { Message, ToolResult } from '../../../shared/contract';
import type { CompletionSummaryRecord } from '../../../shared/contract/completionSummary';
import { makeEvidenceRef, type EvidenceRef } from '../../../shared/contract/evidence';
import { createLogger } from '../../services/infra/logger';
import { resolveRegisteredTurnOutcome } from '../../services/capabilities/hostCapabilityPorts';
import type { RuntimeContext } from './runtimeContext';
import type { RunTerminalStatus } from './runTerminalStatus';
import type { TraceEvent, TraceEventDataMap, TurnTraceRecorder } from './turnTrace';

const logger = createLogger('TurnOutcomeStamp');

export interface TurnOutcomeStampContext {
  sessionId: string;
  workingDirectory?: string;
  messages: Message[];
  goalMode?: RuntimeContext['goalMode'];
  turnTrace: TurnTraceRecorder;
}

function successfulToolResults(messages: readonly Message[]): ToolResult[] {
  return messages.flatMap((message) => message.toolResults ?? []).filter((result) => result.success);
}

async function genericEvidenceRefs(
  messages: readonly Message[],
  summary: CompletionSummaryRecord | undefined,
  workingDirectory: string,
): Promise<{ refs: EvidenceRef[]; problems: string[] }> {
  const refs: EvidenceRef[] = successfulToolResults(messages).map((result) => makeEvidenceRef({
    id: result.toolCallId,
    kind: 'tool',
    ref: `tool_execution:${result.toolCallId}`,
    source: 'tool_execution_event',
    state: 'candidate',
  }));

  const problems: string[] = [];
  // 聊天内 artifact（kind:'artifact'，只有 artifactId/title，结构上没有 path）也要出证据条目。
  // 基线用 `artifact:${artifactId}` / title 兜底；本刀一度收窄成「只取 artifact.path」，
  // 于是一轮只交付聊天内 artifact 的 run 证据条目从 N 条降为 0，账本上表现为「该轮零交付」。
  // 它们没有落盘文件可回读，所以 state 记 candidate——有交付、但未经字节校验。
  for (const artifact of summary?.artifactRefs ?? []) {
    if (artifact.path) continue;
    const ref = artifact.artifactId ? `artifact:${artifact.artifactId}` : artifact.title;
    if (!ref) continue;
    refs.push(makeEvidenceRef({ kind: 'artifact', ref, source: 'completion_summary', state: 'candidate' }));
  }
  // 自报产物（artifactRefs[].path）必须回读得到：说交付了却不在盘上，才是要记进账本的问题。
  const declaredPaths = new Set((summary?.artifactRefs ?? []).flatMap((artifact) => artifact.path ? [artifact.path] : []));
  // changedFiles 是 git status/diff 报出来的（completionSummaryService.collectChangedFiles ←
  // gitCommit.ts:124 `stagedFiles.map(f => f.slice(2))`、gitDiff.ts:126 diffSummary.files），
  // 天然含本轮**删掉**的路径和 `old -> new` 重命名串——读不回来是正常的，不是「产物不可读」。
  // 基线对它们无条件出一条 candidate ref、不报错；这里保持同一口径：能回读就升 read，
  // 读不到退回 candidate、不进 problems，verdict 不因一个本就该消失的文件降级。
  const changedPaths = [...new Set(summary?.changedFiles ?? [])].filter((filePath) => !declaredPaths.has(filePath));
  const canonicalPaths = new Set<string>();
  const readback = (filePath: string): boolean => {
    try {
      const { evidence, documentText } = readbackFileEvidence(filePath, workingDirectory, 'completion_file_readback');
      if (canonicalPaths.has(evidence.ref)) return true;
      canonicalPaths.add(evidence.ref);
      if (documentText !== undefined) problems.push(...checkDocumentEvidenceClaims(documentText, messages));
      refs.push(evidence);
      return true;
    } catch {
      return false;
    }
  };
  for (const filePath of declaredPaths) {
    if (!readback(filePath)) problems.push(`COMPLETION_FILE_UNREADABLE: ${filePath}`);
  }
  for (const filePath of changedPaths) {
    if (!readback(filePath)) refs.push(makeEvidenceRef({ kind: 'file', ref: filePath, source: 'completion_summary', state: 'candidate' }));
  }
  for (const verification of summary?.verificationEvidence ?? []) {
    // 只在「明确知道它非零退出」时丢弃证据。生产上普通前台 Bash 的成功返回不写
    // metadata.exitCode（只有 pty 分支写），parseExitCode 于是返回 undefined——
    // 写成 `exitCode !== 0` 会把所有真实跑通的验证证据全部丢掉，verified 在生产中
    // 根本不可达，而单测只因夹具手写了 exitCode: 0 才是绿的。
    if (!verification.success) continue;
    if (typeof verification.exitCode === 'number' && verification.exitCode !== 0) continue;
    refs.push(makeEvidenceRef({
      id: verification.toolCallId,
      kind: 'test',
      ref: verification.outputPreview ?? verification.command,
      source: 'verification_output',
      state: 'read',
    }));
  }
  for (const commitId of summary?.commitIds ?? []) {
    refs.push(makeEvidenceRef({ kind: 'diff', ref: commitId, source: 'completion_summary', state: 'candidate' }));
  }

  const unique = new Map<string, EvidenceRef>();
  for (const ref of refs) unique.set(`${ref.kind}\0${ref.id}\0${ref.ref}`, ref);
  return { refs: [...unique.values()], problems };
}

/**
 * 本 run 的事件。TurnTraceRecorder 每会话一个、events 从不清空；每枚 turn_outcome 印章收掉
 * 一个 run（SessionInspector model.ts segmentTurns 切 run 用的就是这条线）。turnIndex **不能**
 * 当这条线用：它是 run 内迭代号（conversationRuntime.ts run() 里的局部 iterations），每条用户
 * 消息从 1 重启，上一条用户消息第 3 次迭代记的事件与本条第 3 次迭代同号，按 turnIndex 过滤照样命中。
 */
function currentRunEvents(events: readonly TraceEvent[]): readonly TraceEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'turn_outcome') return events.slice(index + 1);
  }
  return events;
}

function latestGoalEvidence(events: readonly TraceEvent[]): EvidenceRef[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'goal_evidence_gate') return event.data.verdict === 'pass' ? event.data.evidenceRefs : [];
  }
  return [];
}

function currentVoiceDispatch(messages: readonly Message[]): Message | undefined {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  return latestUserMessage?.metadata?.voiceDispatch ? latestUserMessage : undefined;
}

async function resolveVoiceOutcome(
  ctx: TurnOutcomeStampContext,
  dispatch: Message,
): Promise<'done' | 'unverified'> {
  return resolveRegisteredTurnOutcome(ctx.sessionId, dispatch.timestamp);
}

async function buildTurnOutcome(
  ctx: TurnOutcomeStampContext,
  terminal: RunTerminalStatus,
  summary?: CompletionSummaryRecord,
): Promise<TraceEventDataMap['turn_outcome']> {
  // 同一把尺：goal gate 证据也只认本 run 的，别把上一条用户消息的 pass 借过来。
  const goalEvidenceRefs = ctx.goalMode ? latestGoalEvidence(currentRunEvents(ctx.turnTrace.getEvents())) : undefined;
  if (goalEvidenceRefs) {
    return {
      terminal,
      verdict: terminal === 'completed'
        ? (goalEvidenceRefs.length > 0 ? 'verified' : 'self_claimed')
        : 'n_a',
      evidenceRefs: goalEvidenceRefs,
      source: 'goal_gates',
    };
  }

  const { refs: evidenceRefs, problems } = await genericEvidenceRefs(ctx.messages, summary, ctx.workingDirectory ?? process.cwd());
  const voiceDispatch = currentVoiceDispatch(ctx.messages);
  if (voiceDispatch) {
    if (terminal !== 'completed') {
      return { terminal, verdict: 'n_a', evidenceRefs: [], source: 'voice' };
    }
    const voiceOutcome = await resolveVoiceOutcome(ctx, voiceDispatch);
    return {
      terminal,
      verdict: voiceOutcome === 'done' ? 'verified' : 'self_claimed',
      evidenceRefs: voiceOutcome === 'done' ? evidenceRefs : [],
      source: 'voice',
    };
  }

  if (terminal !== 'completed') {
    return { terminal, verdict: 'n_a', evidenceRefs: [], source: 'generic' };
  }
  return {
    terminal,
    // File readback proves delivery bytes, not the truth of claims inside them.
    // 只看**本 run**（上一枚 turn_outcome 之后）的事件：recorder 随 AgentLoop 构造一次、events
    // 从不清空，扫全量等于「会话里任何一轮命中过一次，此后每轮永久降级」；按 turnIndex 过滤则
    // 挡不住上一条用户消息里同号迭代的残留（见 currentRunEvents 注释）。
    verdict: problems.length === 0
      && !currentRunEvents(ctx.turnTrace.getEvents()).some((event) => event.type === 'evidence_boundary')
      && evidenceRefs.some((ref) => ref.kind === 'test' && ref.freshness.state === 'read')
      ? 'verified' : 'self_claimed',
    evidenceRefs,
    source: 'generic',
    evidenceProblems: problems,
  };
}

/** Append-only, fail-safe side ledger: a stamp failure must never block run settlement. */
export async function recordTurnOutcomeStamp(
  ctx: TurnOutcomeStampContext,
  terminal: RunTerminalStatus,
  summary?: CompletionSummaryRecord,
): Promise<void> {
  try {
    const outcome = await buildTurnOutcome(ctx, terminal, summary);
    ctx.turnTrace.record('turn_outcome', outcome);
    if (!ctx.turnTrace.flush()) logger.warn('turn outcome trace flush failed', { sessionId: ctx.sessionId });
  } catch (error) {
    logger.warn('turn outcome stamp failed', {
      sessionId: ctx.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
