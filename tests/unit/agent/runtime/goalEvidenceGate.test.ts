import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { runGoalEvidenceGate } from '../../../../src/host/agent/runtime/goalEvidenceGate';
import { GOAL_MODE } from '../../../../src/shared/constants/agent';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { ToolCall } from '../../../../src/shared/contract';

function makeCtx(overrides: Record<string, unknown> = {}): RuntimeContext {
  return {
    workingDirectory: '/tmp/evidence-gate-test',
    messages: [],
    goalMode: { getVerifyCommand: () => undefined },
    ...overrides,
  } as unknown as RuntimeContext;
}

function makeCall(evidence?: Record<string, unknown>): ToolCall {
  return {
    id: 'c1',
    name: 'attempt_completion',
    arguments: { summary: 'done', ...(evidence ? { evidence } : {}) },
  } as ToolCall;
}

describe('runGoalEvidenceGate（闸0 公开证据自证）', () => {
  it('纯软目标 + 零证据 → 打回并给出补证指引', () => {
    const ctx = makeCtx();
    const result = runGoalEvidenceGate(ctx, makeCall());

    expect(result.verdict).toBe('bounce');
    expect(result.feedback).toContain('goal-evidence-gate-failed');
    expect(ctx.goalEvidenceGateBounces).toBe(1);
  });

  it('有确定性 verifyCommand + 零证据 → 直接放行给闸1（不多烧打回轮次）', () => {
    const ctx = makeCtx({ goalMode: { getVerifyCommand: () => 'npm test' } });
    const result = runGoalEvidenceGate(ctx, makeCall());

    expect(result.verdict).toBe('pass');
    expect(result.reason).toContain('deferring to deterministic gate 1');
    expect(ctx.goalEvidenceGateBounces).toBeUndefined();
  });

  it('自报产物真实存在 → pass 并产出 file EvidenceRef', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evidence-gate-'));
    const filePath = path.join(dir, 'report.html');
    await writeFile(filePath, '<html></html>', 'utf-8');
    const ctx = makeCtx({ workingDirectory: dir });

    const result = runGoalEvidenceGate(ctx, makeCall({ deliverables: ['report.html'] }));

    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs).toHaveLength(1);
    expect(result.evidenceRefs[0]).toMatchObject({ kind: 'file', source: 'goal-evidence-gate' });
  });

  it('自报产物不存在 → 打回并点名缺失文件', () => {
    const ctx = makeCtx();
    const result = runGoalEvidenceGate(ctx, makeCall({ deliverables: ['ghost.html'] }));

    expect(result.verdict).toBe('bounce');
    expect(result.feedback).toContain('ghost.html');
  });

  it('自报命令与会话内真实执行记录匹配 → pass', () => {
    const ctx = makeCtx({
      messages: [
        {
          id: 'm1', role: 'assistant', content: '', timestamp: 1,
          toolCalls: [{ id: 't1', name: 'Bash', arguments: { command: 'npx vitest run   tests/unit' } }],
        },
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ commands: ['npx vitest run tests/unit'] }));

    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs[0]).toMatchObject({ kind: 'tool' });
  });

  it('自报命令在会话内找不到执行记录 → 打回', () => {
    const ctx = makeCtx({ messages: [] });
    const result = runGoalEvidenceGate(ctx, makeCall({ commands: ['cargo build --release'] }));

    expect(result.verdict).toBe('bounce');
    expect(result.feedback).toContain('cargo build --release');
  });

  it('事先声明的产物（declaredDeliverables）缺失 → 即使自报证据齐也打回', () => {
    const ctx = makeCtx({
      declaredDeliverables: { finalArtifacts: ['promised.html'], declaredAtMs: 1 },
      messages: [
        {
          id: 'm1', role: 'assistant', content: '', timestamp: 1,
          toolCalls: [{ id: 't1', name: 'Bash', arguments: { command: 'echo ok' } }],
        },
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ commands: ['echo ok'] }));

    expect(result.verdict).toBe('bounce');
    expect(result.feedback).toContain('promised.html');
    expect(result.feedback).toContain('事先声明的产物');
  });

  it('工作区卫生：声明外散落写入只出警告不打回', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evidence-gate-hygiene-'));
    const filePath = path.join(dir, 'app.html');
    await writeFile(filePath, '<html></html>', 'utf-8');
    const ctx = makeCtx({
      workingDirectory: dir,
      declaredDeliverables: { finalArtifacts: ['app.html'], declaredAtMs: 1 },
      messages: [
        {
          id: 'm1', role: 'assistant', content: '', timestamp: 1,
          toolCalls: [
            { id: 't1', name: 'Write', arguments: { file_path: 'app.html', content: 'x' } },
            { id: 't2', name: 'Write', arguments: { file_path: 'stray-notes.md', content: 'x' } },
          ],
        },
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ deliverables: ['app.html'] }));

    expect(result.verdict).toBe('pass');
    expect(result.reason).toContain('workspace hygiene warning');
    expect(result.reason).toContain('stray-notes.md');
  });

  it('打回预算用尽 → exhausted_release 放行进闸1/闸2', () => {
    const ctx = makeCtx({ goalEvidenceGateBounces: GOAL_MODE.EVIDENCE_GATE_MAX_BOUNCES });
    const result = runGoalEvidenceGate(ctx, makeCall());

    expect(result.verdict).toBe('exhausted_release');
    expect(result.reason).toContain('bounces exhausted');
  });
});
