import { runGoalEvidenceGate } from '../../../src/host/agent/runtime/goalEvidenceGate';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
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
  it('canonicalizes and hashes real files, excludes missing duplicates, and refuses a verified stamp', async () => {
    mkdirSync(traceRoot, { recursive: true });
    const artifact = path.join(traceRoot, 'report.md');
    writeFileSync(artifact, 'Fixture report');
    const recorder = new TurnTraceRecorder('paths', traceRoot);
    const ctx = { ...context(recorder), workingDirectory: traceRoot };
    await recordTurnOutcomeStamp(ctx, 'completed', summary({ changedFiles: [artifact, 'report.md', 'missing/report.md'],
      artifactRefs: [{ kind: 'file', path: artifact }] }));
    const outcome = latestOutcome(recorder);
    expect(outcome.verdict).toBe('self_claimed');
    expect(outcome.evidenceRefs).toHaveLength(1);
    expect(outcome.evidenceRefs[0].freshness).toMatchObject({ state: 'read', digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(outcome.evidenceProblems).toEqual(['COMPLETION_FILE_UNREADABLE: missing/report.md']);
  });

  it('does not promote failed verification or old successful reads to completed evidence', async () => {
    const recorder = new TurnTraceRecorder('failed-verification', traceRoot);
    await recordTurnOutcomeStamp(context(recorder), 'completed', summary({ verificationEvidence: [
      { kind: 'command', toolCallId: 'test-failed', command: 'npm test', success: false, exitCode: 1 },
    ] }));
    expect(latestOutcome(recorder).verdict).toBe('self_claimed');
    expect(latestOutcome(recorder).evidenceRefs).toEqual([]);
  });

  it('retains successful verification after a recovered failure', async () => {
    const recorder = new TurnTraceRecorder('recovery', traceRoot);
    await recordTurnOutcomeStamp(context(recorder), 'completed', summary({ verificationEvidence: [
      { kind: 'command', toolCallId: 'test-ok', command: 'npm test', success: true, exitCode: 0 },
    ] }));
    expect(latestOutcome(recorder).verdict).toBe('verified');
  });

  // ai-review #1740 Important：生产上普通前台 Bash 的成功返回**不写** metadata.exitCode
  // （只有 pty 分支写，bash.ts:992 那条 meta 里没有），parseExitCode 于是返回 undefined。
  // 这条夹具刻意不给 exitCode，钉住「不知道退出码」不等于「退出码非零」——否则 verified
  // 在生产中根本不可达，而上面那条只因夹具手写了 exitCode: 0 才是绿的（测试替身比真实依赖宽容）。
  // ai-review #1740 Important：verdict 里的 evidence_boundary 检查只能看**本轮**。
  // TurnTraceRecorder 随 AgentLoop 构造一次、events 从不清空，扫全量等于「会话里任何一轮
  // 命中过一次，此后每轮永久降级」——第 2 轮写了句「这些是独立来源。」，第 9 轮就算真跑通
  // npm test 也照样 self_claimed，verdict 这个字段在该会话内彻底失去区分能力。
  // ai-review #1740 Important：聊天内 artifact（kind:'artifact'，只有 artifactId/title，
  // 结构上没有 path）也要出证据条目。本刀一度把 artifactRefs 收窄成「只取 artifact.path」，
  // 一轮只交付聊天内 artifact 的 run 证据条目就从 N 条降为 0，SessionInspector 的
  // evidenceCount 显示 0，账本上表现为「该轮零交付」。基线有 artifact:${id} / title 兜底。
  it('keeps evidence for a chat-only artifact that has no path on disk', async () => {
    const recorder = new TurnTraceRecorder('chat-artifact', traceRoot);
    await recordTurnOutcomeStamp(context(recorder), 'completed', summary({
      artifactRefs: [{ kind: 'artifact', artifactId: 'a1', title: '简报' }],
    }));
    const refs = latestOutcome(recorder).evidenceRefs;
    expect(refs.some((ref) => ref.kind === 'artifact' && ref.ref === 'artifact:a1')).toBe(true);
    expect(refs.every((ref) => ref.freshness.state !== 'read' || ref.kind !== 'artifact')).toBe(true);
  });

  it('an earlier turn boundary does not permanently downgrade later turns', async () => {
    const recorder = new TurnTraceRecorder('turn-scope', traceRoot);
    recorder.setTurn(1);
    recorder.record('evidence_boundary', { problems: ['SOURCE_INDEPENDENCE_UNVERIFIED'], surface: 'final_response' });
    recorder.setTurn(2);
    await recordTurnOutcomeStamp(context(recorder), 'completed', summary({ verificationEvidence: [
      { kind: 'command', toolCallId: 'test-ok', command: 'npm test', success: true, exitCode: 0 },
    ] }));
    expect(latestOutcome(recorder).verdict).toBe('verified');
  });

  it('a boundary recorded in this very turn still downgrades it', async () => {
    const recorder = new TurnTraceRecorder('turn-scope-same', traceRoot);
    recorder.setTurn(3);
    recorder.record('evidence_boundary', { problems: ['SOURCE_INDEPENDENCE_UNVERIFIED'], surface: 'final_response' });
    await recordTurnOutcomeStamp(context(recorder), 'completed', summary({ verificationEvidence: [
      { kind: 'command', toolCallId: 'test-ok', command: 'npm test', success: true, exitCode: 0 },
    ] }));
    expect(latestOutcome(recorder).verdict).toBe('self_claimed');
  });

  it('treats an unrecorded exit code as unknown, not as a failure', async () => {
    const recorder = new TurnTraceRecorder('exit-unknown', traceRoot);
    await recordTurnOutcomeStamp(context(recorder), 'completed', summary({ verificationEvidence: [
      { kind: 'command', toolCallId: 'test-ok', command: 'npm test', success: true },
    ] }));
    expect(latestOutcome(recorder).verdict).toBe('verified');
  });

  it('still drops evidence from a command that demonstrably exited non-zero', async () => {
    const recorder = new TurnTraceRecorder('exit-nonzero', traceRoot);
    await recordTurnOutcomeStamp(context(recorder), 'completed', summary({ verificationEvidence: [
      { kind: 'command', toolCallId: 'test-bad', command: 'npm test', success: true, exitCode: 2 },
    ] }));
    expect(latestOutcome(recorder).verdict).not.toBe('verified');
  });

  it.each([
    ['核验要求：至少两份独立来源，才能标记已验证。', undefined],
    ['这些不是独立来源。', undefined],
    ['引用：“这些是独立来源。”', undefined],
    ['这些是独立来源。', 'SOURCE_INDEPENDENCE_UNVERIFIED'],
    ['空间主人：owner-fixture，自动化配置待查。', 'SPACE_OWNER_UNVERIFIED'],
    ['空间主人：owner-fixture；自动化配置待查。', 'SPACE_OWNER_UNVERIFIED'],
    ['空间专家成员：expert-fixture，空间主人待查。', 'SPACE_MEMBERS_UNVERIFIED'],
    ['空间没有自动化，成员待查。', 'SPACE_AUTOMATIONS_UNVERIFIED'],
    ['空间主人待查，自动化配置待查。', undefined],
  ])('checks actual completion-file readback and goal evidence: %s', async (content, problem) => {
    mkdirSync(traceRoot, { recursive: true });
    const artifact = path.join(traceRoot, 'boundary.md');
    writeFileSync(artifact, content);
    const recorder = new TurnTraceRecorder('boundary-completion', traceRoot);
    const ctx = { ...context(recorder), workingDirectory: traceRoot };
    await recordTurnOutcomeStamp(ctx, 'completed', summary({ changedFiles: [artifact], verificationEvidence: [
      { kind: 'command', toolCallId: 'test-ok', command: 'fixture-check', success: true, exitCode: 0 },
    ] }));
    expect(latestOutcome(recorder).evidenceProblems).toEqual(problem ? [problem] : []);
    expect(latestOutcome(recorder).verdict).toBe(problem ? 'self_claimed' : 'verified');
    const goal = runGoalEvidenceGate({ ...ctx, artifact: ArtifactState.forTest(), goalEvidenceState: { bounces: 0 },
      goalMode: { getVerifyCommand: () => undefined },
    } as unknown as RuntimeContext, { id: 'completion', name: 'attempt_completion', arguments: { evidence: { deliverables: [artifact] } } });
    // 2026-09-11 爸拍板改记录式：goal 门不再因为文档断言问题打回（原本会把模型反复打回
    // 到预算耗尽），产物的存在性证据照常收下。留痕仍在——上面 evidenceProblems 与
    // verdict='self_claimed' 两条断言不变，turnTrace 里也有 evidence_boundary 事件。
    expect(goal.verdict).toBe('pass');
    expect(goal.evidenceRefs).toHaveLength(1);
  });

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

  it('records a successful tool as candidate evidence without verifying its conclusions', async () => {
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
      verdict: 'self_claimed',
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
