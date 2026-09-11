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
import { NudgeManager } from '../../../src/host/agent/nudgeManager';
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
    const missing = path.join(traceRoot, 'missing', 'report.md');
    writeFileSync(artifact, 'Fixture report');
    const recorder = new TurnTraceRecorder('paths', traceRoot);
    // summary 的文件清单在生产里是 completionSummaryService 归一化后的绝对路径，
    // 且本 run 的工具结果（写入点）会报出同一份清单——夹具照这个真实形状写。
    const messages = [message(), message({
      id: 'wrote-report', role: 'assistant', content: '',
      toolResults: [{ toolCallId: 'write-report', success: true, metadata: { changedFiles: [artifact, missing, 'report.md'] } }],
    })];
    const ctx = { ...context(recorder, messages), workingDirectory: traceRoot };
    await recordTurnOutcomeStamp(ctx, 'completed', summary({ changedFiles: [artifact, 'report.md'],
      artifactRefs: [{ kind: 'file', path: artifact }, { kind: 'file', path: missing }] }));
    const outcome = latestOutcome(recorder);
    expect(outcome.verdict).toBe('self_claimed');
    const fileRefs = outcome.evidenceRefs.filter((ref) => ref.kind === 'file');
    expect(fileRefs).toHaveLength(1);
    expect(fileRefs[0].freshness).toMatchObject({ state: 'read', digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(outcome.evidenceProblems).toEqual([`COMPLETION_FILE_UNREADABLE: ${missing}`]);
  });

  // ai-review #1740 第 7 轮 Important：changedFiles 来自 git status/diff（gitCommit.ts:124 剥掉状态位后
  // ` D path` 就是已删除路径、`R  old -> new` 剥完是 `old -> new`），回读必失败。基线对它们无条件出
  // candidate ref 不报错；本刀一度把它们记成 COMPLETION_FILE_UNREADABLE 并降级 verdict——账本对一个
  // 本轮故意删掉的文件说「产物不可读」，与本单要交付的「账本不说假话」正好相反。
  it('a file deleted or renamed this turn stays a candidate ref and never downgrades the verdict', async () => {
    const recorder = new TurnTraceRecorder('deleted-changed-file', traceRoot);
    const messages = [message(), message({
      id: 'removed-docs', role: 'assistant', content: '',
      toolResults: [{ toolCallId: 'remove-docs', success: true, metadata: { changedFiles: ['docs/old.md', 'docs/old.md -> docs/new.md'] } }],
    })];
    const ctx = { ...context(recorder, messages), workingDirectory: traceRoot };
    await recordTurnOutcomeStamp(ctx, 'completed', summary({
      changedFiles: ['docs/old.md', 'docs/old.md -> docs/new.md'],
      verificationEvidence: [{ kind: 'command', toolCallId: 'test-ok', command: 'npm test', success: true, exitCode: 0 }],
    }));
    const outcome = latestOutcome(recorder);
    expect(outcome.evidenceProblems).toEqual([]);
    expect(outcome.verdict).toBe('verified');
    expect(outcome.evidenceRefs.filter((ref) => ref.kind === 'file').map((ref) => [ref.ref, ref.freshness.state]))
      .toEqual([['docs/old.md', 'candidate'], ['docs/old.md -> docs/new.md', 'candidate']]);
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

  // ai-review #1740 第 7 轮 Important：上一版按 turnIndex 过滤，但 turnIndex 是 run 内迭代号、每条用户
  // 消息从 1 重启（conversationRuntime.ts 的局部 iterations），recorder 却是每会话一个——上一条用户消息
  // 第 3 次迭代记的 boundary 与本条第 3 次迭代同号，照样命中。「本轮」的线是上一枚 turn_outcome 印章。
  it('a boundary from an earlier run does not downgrade the next run, even at the same iteration number', async () => {
    const recorder = new TurnTraceRecorder('turn-scope', traceRoot);
    recorder.setTurn(3);
    recorder.record('evidence_boundary', { problems: ['SOURCE_INDEPENDENCE_UNVERIFIED'], surface: 'final_response' });
    await recordTurnOutcomeStamp(context(recorder), 'completed', summary());
    expect(latestOutcome(recorder).verdict).toBe('self_claimed');
    recorder.setTurn(3);
    await recordTurnOutcomeStamp(context(recorder), 'completed', summary({ verificationEvidence: [
      { kind: 'command', toolCallId: 'test-ok', command: 'npm test', success: true, exitCode: 0 },
    ] }));
    expect(latestOutcome(recorder).verdict).toBe('verified');
  });

  it('a boundary from an earlier iteration of the same run still downgrades it', async () => {
    const recorder = new TurnTraceRecorder('turn-scope-same-run', traceRoot);
    recorder.setTurn(1);
    recorder.record('evidence_boundary', { problems: ['SOURCE_INDEPENDENCE_UNVERIFIED'], surface: 'final_response' });
    recorder.setTurn(2);
    await recordTurnOutcomeStamp(context(recorder), 'completed', summary({ verificationEvidence: [
      { kind: 'command', toolCallId: 'test-ok', command: 'npm test', success: true, exitCode: 0 },
    ] }));
    expect(latestOutcome(recorder).verdict).toBe('self_claimed');
  });

  // ai-review #1740 第 8 轮 Important（arbitrate 二审维持）：summary 的 changedFiles/artifactRefs
  // 是会话级清单（collectChangedFiles 扫全 ctx.messages，nudgeManager.modifiedFiles 只增不减），
  // 拿它做回读+断言扫描，第 1 轮写的含「这些是独立来源。」的 report.md 会在第 5 轮被重读并记
  // SOURCE_INDEPENDENCE_UNVERIFIED——旧账记在本轮头上，verdict 失去判别力。回读集合按本 run 切。
  it('an artifact written in an earlier run does not downgrade the current run', async () => {
    mkdirSync(traceRoot, { recursive: true });
    const artifact = path.join(traceRoot, 'report.md');
    writeFileSync(artifact, '这些是独立来源。');
    const recorder = new TurnTraceRecorder('run-scope-files', traceRoot);
    const run1 = [
      message({ id: 'user-1' }),
      message({ id: 'assistant-1', role: 'assistant', content: '',
        toolResults: [{ toolCallId: 'write-report', success: true, metadata: { outputPath: artifact } }] }),
    ];
    // 第 1 轮：报告是本轮写的，断言问题就该记在本轮账上。
    await recordTurnOutcomeStamp({ ...context(recorder, run1), workingDirectory: traceRoot }, 'completed',
      summary({ artifactRefs: [{ kind: 'file', path: artifact }] }));
    expect(latestOutcome(recorder).evidenceProblems).toEqual(['SOURCE_INDEPENDENCE_UNVERIFIED']);
    // 第 5 轮：只跑测试、一个文档都没碰；会话级清单仍带着 report.md，但那不是本轮的账。
    const run5 = [
      ...run1,
      message({ id: 'user-2', content: '再跑一遍测试' }),
      message({ id: 'assistant-2', role: 'assistant', content: '测试全绿' }),
    ];
    await recordTurnOutcomeStamp({ ...context(recorder, run5), workingDirectory: traceRoot }, 'completed', summary({
      artifactRefs: [{ kind: 'file', path: artifact }],
      verificationEvidence: [{ kind: 'command', toolCallId: 'test-ok', command: 'npm test', success: true, exitCode: 0 }],
    }));
    const outcome = latestOutcome(recorder);
    expect(outcome.evidenceProblems).toEqual([]);
    expect(outcome.verdict).toBe('verified');
    // 旧产物不消失，仍挂 candidate 条目如实列出，只是不回读、不降级。
    expect(outcome.evidenceRefs.some((ref) => ref.kind === 'file' && ref.ref === artifact && ref.freshness.state === 'candidate')).toBe(true);
  });

  it('a declared artifact deleted between runs does not report UNREADABLE on later runs', async () => {
    mkdirSync(traceRoot, { recursive: true });
    const artifact = path.join(traceRoot, 'report.md');
    writeFileSync(artifact, 'Fixture report');
    const recorder = new TurnTraceRecorder('run-scope-deleted', traceRoot);
    const run1 = [
      message({ id: 'user-1' }),
      message({ id: 'assistant-1', role: 'assistant', content: '',
        toolResults: [{ toolCallId: 'write-report', success: true, metadata: { outputPath: artifact } }] }),
    ];
    await recordTurnOutcomeStamp({ ...context(recorder, run1), workingDirectory: traceRoot }, 'completed',
      summary({ artifactRefs: [{ kind: 'file', path: artifact }] }));
    rmSync(artifact);
    const run2 = [
      ...run1,
      message({ id: 'user-2', content: '跑测试' }),
      message({ id: 'assistant-2', role: 'assistant', content: '绿了' }),
    ];
    await recordTurnOutcomeStamp({ ...context(recorder, run2), workingDirectory: traceRoot }, 'completed', summary({
      artifactRefs: [{ kind: 'file', path: artifact }],
      verificationEvidence: [{ kind: 'command', toolCallId: 'test-ok', command: 'npm test', success: true, exitCode: 0 }],
    }));
    const outcome = latestOutcome(recorder);
    expect(outcome.evidenceProblems).toEqual([]);
    expect(outcome.verdict).toBe('verified');
  });

  // ai-review #1745 第 1 轮 Important：bash/脚本/子代理写的文件没有 outputPath 可报，
  // 只进 nudgeManager 账（toolFileMutationTracking.ts）——本 run 的集合必须带上它，
  // 否则本轮 bash 写的含未核实声明的文档永不回读，verdict 照样 verified。
  it('a bash-written document this run is read back via nudge tracking', async () => {
    mkdirSync(traceRoot, { recursive: true });
    const artifact = path.join(traceRoot, 'report.md');
    writeFileSync(artifact, '这些是独立来源。');
    const recorder = new TurnTraceRecorder('run-scope-bash', traceRoot);
    const nudgeManager = new NudgeManager();
    const userTimestamp = 1_700_000_000_000;
    nudgeManager.trackModifiedFile(artifact, userTimestamp + 1);
    const messages = [
      message({ timestamp: userTimestamp }),
      message({ id: 'assistant-1', role: 'assistant', content: '',
        toolResults: [{ toolCallId: 'bash-write', success: true, output: 'written' }] }),
    ];
    await recordTurnOutcomeStamp({ ...context(recorder, messages), workingDirectory: traceRoot, nudgeManager },
      'completed', summary({ changedFiles: [artifact] }));
    const outcome = latestOutcome(recorder);
    expect(outcome.evidenceProblems).toEqual(['SOURCE_INDEPENDENCE_UNVERIFIED']);
    expect(outcome.verdict).toBe('self_claimed');
  });

  it('a nudge-tracked file from before this run stays out of the readback set', async () => {
    mkdirSync(traceRoot, { recursive: true });
    const artifact = path.join(traceRoot, 'report.md');
    writeFileSync(artifact, '这些是独立来源。');
    const recorder = new TurnTraceRecorder('run-scope-nudge-old', traceRoot);
    const nudgeManager = new NudgeManager();
    const userTimestamp = 1_700_000_000_000;
    nudgeManager.trackModifiedFile(artifact, userTimestamp - 1_000);
    const messages = [
      message({ timestamp: userTimestamp }),
      message({ id: 'assistant-1', role: 'assistant', content: '测试全绿' }),
    ];
    await recordTurnOutcomeStamp({ ...context(recorder, messages), workingDirectory: traceRoot, nudgeManager }, 'completed', summary({
      changedFiles: [artifact],
      verificationEvidence: [{ kind: 'command', toolCallId: 'test-ok', command: 'npm test', success: true, exitCode: 0 }],
    }));
    const outcome = latestOutcome(recorder);
    expect(outcome.evidenceProblems).toEqual([]);
    expect(outcome.verdict).toBe('verified');
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
    const messages = [message(), message({
      id: 'wrote-boundary', role: 'assistant', content: '',
      toolResults: [{ toolCallId: 'write-boundary', success: true, metadata: { outputPath: artifact } }],
    })];
    const ctx = { ...context(recorder, messages), workingDirectory: traceRoot };
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
