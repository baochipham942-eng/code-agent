// Optional fast Jev compaction for tool rounds. It preserves source text,
// except for the explicit 300-character result truncation case.

import { estimateTokens } from './tokenEstimator';
import type { ProjectableMessage } from './projectionEngine';
import {
  buildJevCompactionQuestions,
  JEV_COMPACTION_THRESHOLDS,
  type JevAnswers,
  type JevSystemOneCall,
} from '../../shared/constants/jevQuestions';
import { guardSensitiveText } from '../security/sensitiveDataGuard';

export interface JevCompactionResult {
  skipped: boolean;
  changed: boolean;
  droppedMessages: number;
  truncatedResults: number;
  compressionRatio: number;
  spotCheckPassed: boolean;
  reason?: 'disabled' | 'no_candidates' | 'unavailable' | 'bad_shape';
}

interface Candidate {
  key: string;
  message: ProjectableMessage;
  kind: 'call' | 'result';
  toolCallIds: string[];
  toolCallId?: string;
  pinned: boolean;
  protected: boolean;
}

/** Safe entries are never judged, dropped, or truncated: the latest six tool entries plus user-protected messages. */
function isSafe(candidate: Candidate): boolean {
  return candidate.pinned || candidate.protected;
}

function isNoul(value: unknown): value is { noul: number } {
  return typeof value === 'object' && value !== null && 'noul' in value
    && typeof (value as { noul?: unknown }).noul === 'number'
    && Number.isFinite((value as { noul: number }).noul)
    && (value as { noul: number }).noul >= 0 && (value as { noul: number }).noul <= 1;
}

function safeKey(id: string, used: Set<string>): string {
  const base = `entry_${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unknown'}`;
  let key = base;
  let suffix = 2;
  while (used.has(key)) key = `${base}_${suffix++}`;
  used.add(key);
  return key;
}

function buildCandidates(messages: ProjectableMessage[], protectedMessageIds?: Set<string>): Candidate[] {
  const used = new Set<string>();
  const toolMessages = messages.filter((message) =>
    Array.isArray(message.toolCalls) || typeof message.toolCallId === 'string');
  // Positional pin of the latest six entries; user protection is a union on top,
  // so a protected entry never consumes a pin slot from a recent entry.
  const pinnedIds = new Set(toolMessages.slice(-JEV_COMPACTION_THRESHOLDS.pinnedLatestEntries).map((message) => message.id));
  return toolMessages.map((message) => ({
    key: safeKey(message.id, used),
    message,
    kind: Array.isArray(message.toolCalls) ? 'call' : 'result',
    toolCallIds: Array.isArray(message.toolCalls)
      ? (message.toolCalls as Array<{ id?: unknown }>).flatMap((call) => typeof call.id === 'string' ? [call.id] : [])
      : [],
    toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
    pinned: pinnedIds.has(message.id),
    protected: protectedMessageIds?.has(message.id) ?? false,
  }));
}

function unavailable(reason: JevCompactionResult['reason']): JevCompactionResult {
  return {
    skipped: true,
    changed: false,
    droppedMessages: 0,
    truncatedResults: 0,
    compressionRatio: 1,
    spotCheckPassed: true,
    reason,
  };
}

export function isJevCompactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_JEV_COMPACTION === '1';
}

export interface JevCompactionOptions {
  /** User pinned/retained + protectedToolResultPredicate ids from the pipeline; never judged, dropped, or truncated. */
  protectedMessageIds?: Set<string>;
}

export async function applyJevCompaction(
  messages: ProjectableMessage[],
  systemOne?: JevSystemOneCall,
  options?: JevCompactionOptions,
): Promise<JevCompactionResult> {
  if (!isJevCompactionEnabled()) return unavailable('disabled');
  const candidates = buildCandidates(messages, options?.protectedMessageIds);
  const active = candidates.filter((candidate) => !isSafe(candidate));
  if (active.length === 0) return unavailable('no_candidates');

  const batches: Candidate[][] = [];
  let batch: Candidate[] = [];
  let batchTokens = 0;
  for (const candidate of active) {
    const cost = estimateTokens(candidate.message.content) + 80;
    if (batch.length > 0 && batchTokens + cost > JEV_COMPACTION_THRESHOLDS.maxBatchTokens) {
      batches.push(batch);
      batch = [];
      batchTokens = 0;
    }
    batch.push(candidate);
    batchTokens += cost;
  }
  if (batch.length > 0) batches.push(batch);

  const call = systemOne ?? (async (state, questions, options) => {
    const { systemOne: productionSystemOne } = await import('../model/providers/typesafeProvider');
    return productionSystemOne(state, questions, options);
  });
  const decisions = new Map<string, { keepCall: boolean; keepResult: boolean }>();
  try {
    for (const currentBatch of batches) {
      const entries: Record<string, unknown> = {};
      const keys: string[] = [];
      for (const candidate of currentBatch) {
        keys.push(candidate.key);
        entries[candidate.key] = {
          role: candidate.message.role,
          kind: candidate.kind,
          content: guardSensitiveText(candidate.message.content.slice(0, 12_000), {
            surface: 'telemetry', mode: 'model-context',
          }),
        };
      }
      const answers: JevAnswers = await call({ entries }, buildJevCompactionQuestions(keys));
      for (const candidate of currentBatch) {
        const callAnswer = answers[`keep_call_${candidate.key}`];
        const resultAnswer = answers[`keep_result_${candidate.key}`];
        if (!isNoul(callAnswer) || !isNoul(resultAnswer)) return unavailable('bad_shape');
        decisions.set(candidate.key, {
          keepCall: callAnswer.noul >= JEV_COMPACTION_THRESHOLDS.keep,
          keepResult: resultAnswer.noul >= JEV_COMPACTION_THRESHOLDS.keep,
        });
      }
    }
  } catch {
    return unavailable('unavailable');
  }

  const callById = new Map<string, Candidate>();
  const resultsByCallId = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    for (const id of candidate.toolCallIds) callById.set(id, candidate);
    if (candidate.toolCallId) {
      const paired = resultsByCallId.get(candidate.toolCallId) ?? [];
      paired.push(candidate);
      resultsByCallId.set(candidate.toolCallId, paired);
    }
  }
  // Pair integrity holds in both directions: a surviving call keeps its results
  // (truncated at most, never dropped) and a surviving result keeps its call —
  // when Jev would drop a call whose result is safe, the call is kept instead.
  // Compaction may keep more at pair boundaries, never orphan.
  const removeIds = new Set<string>();
  const truncateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== 'call' || isSafe(candidate)) continue;
    const decision = decisions.get(candidate.key);
    if (decision?.keepCall !== false) continue;
    const results = candidate.toolCallIds.flatMap((id) => resultsByCallId.get(id) ?? []);
    if (results.some(isSafe)) continue;
    removeIds.add(candidate.message.id);
    for (const result of results) removeIds.add(result.message.id);
  }
  for (const candidate of candidates) {
    if (candidate.kind !== 'result' || !candidate.toolCallId || isSafe(candidate)) continue;
    if (removeIds.has(candidate.message.id)) continue;
    const call = callById.get(candidate.toolCallId);
    if (!call) continue; // no paired call in the transcript — fail closed, keep
    const decision = decisions.get(candidate.key);
    if (decision && !decision.keepResult
      && candidate.message.content.length > JEV_COMPACTION_THRESHOLDS.truncatedResultChars) {
      truncateIds.add(candidate.message.id);
    }
  }

  const originalChars = candidates.reduce((total, candidate) => total + candidate.message.content.length, 0);
  let keptChars = originalChars;
  for (const message of messages) {
    if (removeIds.has(message.id)) {
      keptChars -= message.content.length;
    } else if (truncateIds.has(message.id)) {
      keptChars -= Math.max(0, message.content.length - JEV_COMPACTION_THRESHOLDS.truncatedResultChars);
      message.content = message.content.slice(0, JEV_COMPACTION_THRESHOLDS.truncatedResultChars);
    }
  }
  if (removeIds.size > 0) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (removeIds.has(messages[index].id)) messages.splice(index, 1);
    }
  }
  return {
    skipped: false,
    changed: removeIds.size > 0 || truncateIds.size > 0,
    droppedMessages: removeIds.size,
    truncatedResults: truncateIds.size,
    compressionRatio: originalChars === 0 ? 1 : keptChars / originalChars,
    spotCheckPassed: [...truncateIds].every((id) => !messages.some((message) => message.id === id)
      || (messages.find((message) => message.id === id)?.content.length ?? 0) <= JEV_COMPACTION_THRESHOLDS.truncatedResultChars),
  };
}
