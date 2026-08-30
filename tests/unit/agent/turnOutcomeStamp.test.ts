import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

import type { CompletionSummaryRecord, Message } from '../../../src/shared/contract';
import { makeEvidenceRef } from '../../../src/shared/contract/evidence';

const traceRoot = path.join(os.tmpdir(), `turn-outcome-stamp-${process.pid}-${Date.now()}`);

vi.mock('../../../src/host/platform/appPaths', () => ({ getPath: () => traceRoot }));

import { TurnTraceRecorder } from '../../../src/host/agent/runtime/turnTrace';
import type { RunTerminalStatus } from '../../../src/host/agent/runtime/runTerminalStatus';
import {
  recordTurnOutcomeStamp,
  type TurnOutcomeStampContext,
} from '../../../src/host/agent/runtime/turnOutcomeStamp';
import { registerTurnOutcomeResolver } from '../../../src/host/services/capabilities/hostCapabilityPorts';

let cleanupVoiceResolver: (() => void | Promise<void>) | undefined;

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    role: 'user',
    content: '完成任务',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function summary(overrides: Partial<CompletionSummaryRecord> = {}): CompletionSummaryRecord {
  return {
    schemaVersion: 1,
    id: 'completion-1',
    sessionId: 'session-1',
    objective: '完成任务',
    status: 'completed',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_100,
    durationMs: 100,
    iterations: 1,
    tokenUsage: { input: 10, output: 5, total: 15 },
    toolCallCount: 0,
    changedFiles: [],
    commands: [],
    verificationEvidence: [],
    commitIds: [],
    risks: [],
    blockers: [],
    artifactRefs: [],
    ...overrides,
  };
}

function context(
  recorder: TurnTraceRecorder,
  messages: Message[] = [message()],
  goalMode?: TurnOutcomeStampContext['goalMode'],
): TurnOutcomeStampContext {
  return { sessionId: 'session-1', messages, turnTrace: recorder, goalMode };
}

function outcomeEvents(recorder: TurnTraceRecorder) {
  return recorder.getEvents().filter((event) => event.type === 'turn_outcome');
}

function latestOutcome(recorder: TurnTraceRecorder) {
  const event = outcomeEvents(recorder).at(-1);
  if (!event || event.type !== 'turn_outcome') throw new Error('turn_outcome was not recorded');
  return event.data;
}

describe('turn outcome stamp', () => {
  afterEach(() => {
    void cleanupVoiceResolver?.();
    cleanupVoiceResolver = undefined;
    if (existsSync(traceRoot)) rmSync(traceRoot, { recursive: true, force: true });
  });

  it('preserves an explicitly reported cacheReadTokens value on inference events', () => {
    const recorder = new TurnTraceRecorder('session-cache');
    recorder.record('inference', {
      responseType: 'text',
      durationMs: 12,
      inputTokens: 20,
      outputTokens: 4,
      cacheReadTokens: 9,
      finishReason: 'stop',
      truncated: false,
    });

    expect(recorder.getEvents()[0]).toMatchObject({
      type: 'inference',
      data: { cacheReadTokens: 9 },
    });
  });

  it('marks a completed run with no tool, artifact, or verification evidence as self_claimed', async () => {
    const recorder = new TurnTraceRecorder('session-1');

    await recordTurnOutcomeStamp(context(recorder), 'completed', summary());

    expect(outcomeEvents(recorder)).toHaveLength(1);
    expect(outcomeEvents(recorder)[0]).toMatchObject({
      type: 'turn_outcome',
      data: { terminal: 'completed', verdict: 'self_claimed', evidenceRefs: [], source: 'generic' },
    });
  });

  it('uses a real successful tool result as completed-run evidence', async () => {
    const recorder = new TurnTraceRecorder('session-1');
    const messages = [
      message(),
      message({
        id: 'tool-result-message',
        role: 'assistant',
        content: '',
        toolResults: [{ toolCallId: 'tool-call-17', success: true, output: 'ok' }],
      }),
    ];

    await recordTurnOutcomeStamp(context(recorder, messages), 'completed', summary({ toolCallCount: 1 }));

    expect(latestOutcome(recorder)).toMatchObject({
      terminal: 'completed',
      verdict: 'verified',
      source: 'generic',
      evidenceRefs: [{ id: 'tool-call-17', kind: 'tool', ref: 'tool_execution:tool-call-17' }],
    });
  });

  it('records exactly one n_a stamp for each non-completed terminal state', async () => {
    const recorder = new TurnTraceRecorder('session-1');
    const statuses: RunTerminalStatus[] = [
      'completed', 'cancelled', 'interrupted', 'failed', 'goal_met', 'aborted',
    ];

    for (const status of statuses) {
      recorder.setTurn(statuses.indexOf(status) + 1);
      await recordTurnOutcomeStamp(context(recorder), status, summary({ status }));
    }

    const events = outcomeEvents(recorder);
    expect(events).toHaveLength(6);
    expect(events.map((event) => event.data.terminal)).toEqual(statuses);
    expect(events.map((event) => event.data.verdict)).toEqual([
      'self_claimed', 'n_a', 'n_a', 'n_a', 'n_a', 'n_a',
    ]);
  });

  it('reuses goal gate evidence and ignores generic tool evidence', async () => {
    const recorder = new TurnTraceRecorder('session-1');
    const gateEvidence = makeEvidenceRef({
      id: 'goal-gate-file',
      kind: 'file',
      ref: '/tmp/goal-output.txt',
      source: 'goal_evidence_gate',
    });
    recorder.record('goal_evidence_gate', {
      verdict: 'pass',
      reason: 'declared artifact exists',
      evidenceRefs: [gateEvidence],
    });
    const messages = [
      message(),
      message({
        role: 'assistant',
        toolResults: [{ toolCallId: 'generic-tool', success: true, output: 'ok' }],
      }),
    ];

    await recordTurnOutcomeStamp(
      context(recorder, messages, {} as TurnOutcomeStampContext['goalMode']),
      'goal_met',
      summary({ status: 'goal_met', toolCallCount: 1 }),
    );

    expect(latestOutcome(recorder)).toEqual({
      terminal: 'goal_met',
      verdict: 'n_a',
      evidenceRefs: [gateEvidence],
      source: 'goal_gates',
    });
  });

  it('uses the existing voice outcome instead of rejudging generic evidence', async () => {
    const recorder = new TurnTraceRecorder('session-1');
    const voiceResolver = vi.fn(async () => 'unverified' as const);
    cleanupVoiceResolver = registerTurnOutcomeResolver(voiceResolver);
    const messages = [
      message({
        metadata: {
          source: 'voice',
          voiceCallId: 'voice-1',
          voiceDispatch: { title: '写文件', workItemId: 'voice-work-1' },
        },
      }),
      message({
        role: 'assistant',
        toolResults: [{ toolCallId: 'generic-tool', success: true, output: 'ok' }],
      }),
    ];

    await recordTurnOutcomeStamp(
      context(recorder, messages),
      'completed',
      summary({ toolCallCount: 1 }),
    );

    expect(voiceResolver).toHaveBeenCalledWith('session-1', 1_700_000_000_000);
    expect(latestOutcome(recorder)).toEqual({
      terminal: 'completed',
      verdict: 'self_claimed',
      evidenceRefs: [],
      source: 'voice',
    });
  });

  it('keeps a voice dispatch unverified when voice-live has not registered a resolver', async () => {
    const recorder = new TurnTraceRecorder('session-1');
    const messages = [message({
      metadata: {
        source: 'voice',
        voiceCallId: 'voice-1',
        voiceDispatch: { title: '写文件', workItemId: 'voice-work-1' },
      },
    })];

    await recordTurnOutcomeStamp(
      context(recorder, messages),
      'completed',
      summary({ changedFiles: ['/tmp/result.txt'] }),
    );

    expect(latestOutcome(recorder)).toEqual({
      terminal: 'completed',
      verdict: 'self_claimed',
      evidenceRefs: [],
      source: 'voice',
    });
  });
});
