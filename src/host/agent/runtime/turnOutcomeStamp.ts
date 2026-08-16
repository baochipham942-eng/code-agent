import type { Message, ToolResult } from '../../../shared/contract';
import type { CompletionSummaryRecord } from '../../../shared/contract/completionSummary';
import { makeEvidenceRef, type EvidenceRef } from '../../../shared/contract/evidence';
import { createLogger } from '../../services/infra/logger';
import type { RuntimeContext } from './runtimeContext';
import type { RunTerminalStatus } from './runTerminalStatus';
import type { TraceEvent, TraceEventDataMap, TurnTraceRecorder } from './turnTrace';

const logger = createLogger('TurnOutcomeStamp');

type VoiceWorkOutcome = 'done' | 'unverified';

export interface TurnOutcomeStampContext {
  sessionId: string;
  messages: Message[];
  goalMode?: RuntimeContext['goalMode'];
  turnTrace: TurnTraceRecorder;
}

export interface TurnOutcomeStampDependencies {
  resolveVoiceWorkOutcome?: (sessionId: string, dispatchedAtMs: number) => Promise<VoiceWorkOutcome>;
}

function successfulToolResults(messages: readonly Message[]): ToolResult[] {
  return messages.flatMap((message) => message.toolResults ?? []).filter((result) => result.success);
}

function genericEvidenceRefs(
  messages: readonly Message[],
  summary: CompletionSummaryRecord | undefined,
): EvidenceRef[] {
  const refs: EvidenceRef[] = successfulToolResults(messages).map((result) => makeEvidenceRef({
    id: result.toolCallId,
    kind: 'tool',
    ref: `tool_execution:${result.toolCallId}`,
    source: 'tool_execution_event',
  }));

  for (const filePath of summary?.changedFiles ?? []) {
    refs.push(makeEvidenceRef({ kind: 'file', ref: filePath, source: 'completion_summary' }));
  }
  for (const artifact of summary?.artifactRefs ?? []) {
    const ref = artifact.path
      ?? (artifact.artifactId ? `artifact:${artifact.artifactId}` : artifact.title);
    if (!ref) continue;
    refs.push(makeEvidenceRef({
      kind: artifact.kind === 'file' ? 'file' : 'artifact',
      ref,
      source: 'completion_summary',
    }));
  }
  for (const verification of summary?.verificationEvidence ?? []) {
    refs.push(makeEvidenceRef({
      id: verification.toolCallId,
      kind: 'test',
      ref: verification.outputPreview ?? verification.command,
      source: 'verification_output',
    }));
  }
  for (const commitId of summary?.commitIds ?? []) {
    refs.push(makeEvidenceRef({ kind: 'diff', ref: commitId, source: 'completion_summary' }));
  }

  const unique = new Map<string, EvidenceRef>();
  for (const ref of refs) unique.set(`${ref.kind}\0${ref.id}\0${ref.ref}`, ref);
  return [...unique.values()];
}

function latestGoalEvidence(events: readonly TraceEvent[]): EvidenceRef[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'goal_evidence_gate') return event.data.evidenceRefs;
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
  dependencies: TurnOutcomeStampDependencies,
): Promise<VoiceWorkOutcome> {
  if (dependencies.resolveVoiceWorkOutcome) {
    return dependencies.resolveVoiceWorkOutcome(ctx.sessionId, dispatch.timestamp);
  }
  const voiceEvidence = await import('../../services/voice/voiceWorkEvidence');
  return voiceEvidence.resolveVoiceWorkOutcome(ctx.sessionId, dispatch.timestamp);
}

async function buildTurnOutcome(
  ctx: TurnOutcomeStampContext,
  terminal: RunTerminalStatus,
  summary?: CompletionSummaryRecord,
  dependencies: TurnOutcomeStampDependencies = {},
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

  const evidenceRefs = genericEvidenceRefs(ctx.messages, summary);
  const voiceDispatch = currentVoiceDispatch(ctx.messages);
  if (voiceDispatch) {
    if (terminal !== 'completed') {
      return { terminal, verdict: 'n_a', evidenceRefs: [], source: 'voice' };
    }
    const voiceOutcome = await resolveVoiceOutcome(ctx, voiceDispatch, dependencies);
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
    verdict: evidenceRefs.length > 0 ? 'verified' : 'self_claimed',
    evidenceRefs,
    source: 'generic',
  };
}

/** Append-only, fail-safe side ledger: a stamp failure must never block run settlement. */
export async function recordTurnOutcomeStamp(
  ctx: TurnOutcomeStampContext,
  terminal: RunTerminalStatus,
  summary?: CompletionSummaryRecord,
  dependencies: TurnOutcomeStampDependencies = {},
): Promise<void> {
  try {
    const outcome = await buildTurnOutcome(ctx, terminal, summary, dependencies);
    ctx.turnTrace.record('turn_outcome', outcome);
    if (!ctx.turnTrace.flush()) logger.warn('turn outcome trace flush failed', { sessionId: ctx.sessionId });
  } catch (error) {
    logger.warn('turn outcome stamp failed', {
      sessionId: ctx.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
