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
  const paths = new Set([
    ...(summary?.changedFiles ?? []),
    ...(summary?.artifactRefs ?? []).flatMap((artifact) => artifact.path ? [artifact.path] : []),
  ]);
  const canonicalPaths = new Set<string>();
  for (const filePath of paths) {
    try {
      const { evidence, documentText } = readbackFileEvidence(filePath, workingDirectory, 'completion_file_readback');
      if (canonicalPaths.has(evidence.ref)) continue;
      canonicalPaths.add(evidence.ref);
      if (documentText !== undefined) problems.push(...checkDocumentEvidenceClaims(documentText, messages));
      refs.push(evidence);
    } catch {
      problems.push(`COMPLETION_FILE_UNREADABLE: ${filePath}`);
    }
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
  const goalEvidenceRefs = ctx.goalMode ? latestGoalEvidence(ctx.turnTrace.getEvents()) : undefined;
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
    verdict: problems.length === 0 && !ctx.turnTrace.getEvents().some((event) => event.type === 'evidence_boundary') && evidenceRefs.some((ref) => ref.kind === 'test' && ref.freshness.state === 'read')
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
