import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { runGoalEvidenceGate } from '../../../../src/host/agent/runtime/goalEvidenceGate';
import { GOAL_MODE } from '../../../../src/shared/constants/agent';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { Message, ToolCall, ToolResult } from '../../../../src/shared/contract';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';

function makeCtx(overrides: Record<string, unknown> = {}): RuntimeContext {
  return {
    workingDirectory: '/tmp/evidence-gate-test',
    messages: [],
    goalMode: { getVerifyCommand: () => undefined },
    goalEvidenceState: { bounces: 0 },
    artifact: ArtifactState.forTest(),
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

/** assistant 消息：携带模型发起的 toolCalls */
function assistantMsg(toolCalls: ToolCall[]): Message {
  return { id: 'm1', role: 'assistant', content: '', timestamp: 1, toolCalls } as Message;
}

/**
 * role:'tool' 消息：工具结果落进 ctx.messages 的真实形状（messageProcessor.ts 末尾
 * addAndPersistMessage，字段 toolResults: ToolResult[]，按 toolCallId 与 toolCalls 配对）。
 */
function resultsMsg(results: ToolResult[]): Message {
  return { id: 'm2', role: 'tool', content: JSON.stringify(results), timestamp: 2, toolResults: results } as Message;
}

function okResult(toolCallId: string): ToolResult {
  return { toolCallId, success: true, output: 'ok', duration: 10 };
}

/** 审批拒绝（toolExecutor.ts ask-denied 分支：metadata.failureCode = AgentFailureCode.PermissionDenied） */
function deniedResult(toolCallId: string): ToolResult {
  return {
    toolCallId,
    success: false,
    error: 'Permission denied by user: Bash',
    metadata: { failureCode: 'permission-denied' },
  };
}

/** bash 非零退出（bash.ts waitForCompletion：'Command exited with code N'） */
function failedResult(toolCallId: string): ToolResult {
  return { toolCallId, success: false, error: 'Command exited with code 1', metadata: { code: 'FS_ERROR' } };
}

/** headless 无审批 UI fail-closed（permission.ts code PERMISSION_DENIED_NO_APPROVAL_UI） */
function headlessDeniedResult(toolCallId: string): ToolResult {
  return { toolCallId, success: false, error: 'permission denied: no approval UI available', metadata: { code: 'PERMISSION_DENIED_NO_APPROVAL_UI' } };
}

/** 超时（前台 timeout kill → reject） */
function timeoutResult(toolCallId: string): ToolResult {
  return { toolCallId, success: false, error: 'Error: Command timed out after 30000ms', duration: 30000 };
}

/** run 取消（toolExecutionEngine.buildSuppressedCancelledResult 形状） */
function cancelledResult(toolCallId: string): ToolResult {
  return { toolCallId, success: false, error: 'cancelled', duration: 5, metadata: { cancelledByRun: true } };
}

describe('runGoalEvidenceGate（闸0 公开证据自证）', () => {
  it('纯软目标 + 零证据 → 打回并给出补证指引', () => {
    const ctx = makeCtx();
    const result = runGoalEvidenceGate(ctx, makeCall());

    expect(result.verdict).toBe('bounce');
    expect(result.feedback).toContain('goal-evidence-gate-failed');
    expect(ctx.goalEvidenceState.bounces).toBe(1);
  });

  it('有确定性 verifyCommand + 零证据 → 直接放行给闸1（不多烧打回轮次）', () => {
    const ctx = makeCtx({ goalMode: { getVerifyCommand: () => 'npm test' } });
    const result = runGoalEvidenceGate(ctx, makeCall());

    expect(result.verdict).toBe('pass');
    expect(result.reason).toContain('deferring to deterministic gate 1');
    expect(ctx.goalEvidenceState.bounces).toBe(0);
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
        assistantMsg([{ id: 't1', name: 'Bash', arguments: { command: 'npx vitest run   tests/unit' } }]),
        resultsMsg([okResult('t1')]),
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
      artifact: ArtifactState.forTest({
        declaredDeliverables: { finalArtifacts: ['promised.html'], declaredAtMs: 1 },
      }),
      messages: [
        assistantMsg([{ id: 't1', name: 'Bash', arguments: { command: 'echo ok' } }]),
        resultsMsg([okResult('t1')]),
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
      artifact: ArtifactState.forTest({
        declaredDeliverables: { finalArtifacts: ['app.html'], declaredAtMs: 1 },
      }),
      messages: [
        assistantMsg([
          { id: 't1', name: 'Write', arguments: { file_path: 'app.html', content: 'x' } },
          { id: 't2', name: 'Write', arguments: { file_path: 'stray-notes.md', content: 'x' } },
        ]),
        resultsMsg([okResult('t1'), okResult('t2')]),
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ deliverables: ['app.html'] }));

    expect(result.verdict).toBe('pass');
    expect(result.reason).toContain('workspace hygiene warning');
    expect(result.reason).toContain('stray-notes.md');
  });

  it('为每个发生变更的 Source repo 记录独立 HEAD 证据', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evidence-gate-multi-repo-'));
    const roots = [path.join(dir, 'primary'), path.join(dir, 'additional')];
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Agent Neo Test'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'neo@example.invalid'], { cwd: root });
      await writeFile(path.join(root, 'tracked.txt'), 'base\n', 'utf8');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' });
      await writeFile(path.join(root, 'tracked.txt'), 'changed\n', 'utf8');
    }
    const ctx = makeCtx({
      workingDirectory: roots[0],
      messages: [
        assistantMsg([{ id: 't1', name: 'Bash', arguments: { command: 'npm test' } }]),
        resultsMsg([okResult('t1')]),
      ],
      workspaceScope: {
        projectId: 'project-1',
        primaryRoot: roots[0],
        roots: [
          { sourceId: 'primary', path: roots[0], role: 'primary', access: 'read_write' },
          { sourceId: 'additional', path: roots[1], role: 'additional', access: 'read_write' },
        ],
        version: 'scope-v1',
      },
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ commands: ['npm test'] }));

    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs.filter((evidence) => evidence.kind === 'diff').map((evidence) => evidence.ref))
      .toEqual(expect.arrayContaining([
        expect.stringContaining('source:primary'),
        expect.stringContaining('source:additional'),
      ]));
  });

  it('打回预算用尽 → exhausted_release 放行进闸1/闸2', () => {
    const ctx = makeCtx({ goalEvidenceState: { bounces: GOAL_MODE.EVIDENCE_GATE_MAX_BOUNCES } });
    const result = runGoalEvidenceGate(ctx, makeCall());

    expect(result.verdict).toBe('exhausted_release');
    expect(result.reason).toContain('bounces exhausted');
  });
});

describe('N-GOALEVIDENCE-DENIEDCALLS：被拒/失败的调用不算执行过', () => {
  it.each([
    ['审批拒绝（metadata.failureCode=permission-denied）', deniedResult],
    ['执行失败（Command exited with code 1）', failedResult],
    ['headless 无审批 UI fail-closed（PERMISSION_DENIED_NO_APPROVAL_UI）', headlessDeniedResult],
    ['超时（Command timed out）', timeoutResult],
    ['run 取消（error=cancelled）', cancelledResult],
  ])('Bash 调用%s → 声称执行过 ⇒ 打回', (_label, buildResult) => {
    const ctx = makeCtx({
      messages: [
        assistantMsg([{ id: 't1', name: 'Bash', arguments: { command: 'npm test' } }]),
        resultsMsg([buildResult('t1')]),
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ commands: ['npm test'] }));

    expect(result.verdict).toBe('bounce');
    expect(result.feedback).toContain('npm test');
    expect(result.evidenceRefs.some((ref) => ref.kind === 'tool')).toBe(false);
  });

  it('Bash 调用尚无结果（进行中/结果丢失）→ 声称执行过 ⇒ 打回', () => {
    const ctx = makeCtx({
      messages: [assistantMsg([{ id: 't1', name: 'Bash', arguments: { command: 'npm test' } }])],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ commands: ['npm test'] }));

    expect(result.verdict).toBe('bounce');
  });

  it('成功执行 git status，声称 `git status && rm -rf x` ⇒ 打回（短命令的执行记录证明不了更长的声称）', () => {
    const ctx = makeCtx({
      messages: [
        assistantMsg([{ id: 't1', name: 'Bash', arguments: { command: 'git status' } }]),
        resultsMsg([okResult('t1')]),
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ commands: ['git status && rm -rf x'] }));

    expect(result.verdict).toBe('bounce');
    expect(result.feedback).toContain('git status && rm -rf x');
  });

  it('声称命令是已执行命令的前缀（npm test / 实际 npm test -- foo）且不含 shell 操作符 ⇒ 放行（简写兼容）', () => {
    const ctx = makeCtx({
      messages: [
        assistantMsg([{ id: 't1', name: 'Bash', arguments: { command: 'npm test -- foo' } }]),
        resultsMsg([okResult('t1')]),
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ commands: ['npm test'] }));

    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs[0]).toMatchObject({ kind: 'tool' });
  });

  it('声称命令含管道等 shell 操作符时失去前缀兼容资格 ⇒ 打回', () => {
    const ctx = makeCtx({
      messages: [
        assistantMsg([{ id: 't1', name: 'Bash', arguments: { command: 'cat log.txt | grep error' } }]),
        resultsMsg([okResult('t1')]),
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ commands: ['cat log.txt | grep error; rm x'] }));

    expect(result.verdict).toBe('bounce');
  });

  it('同轮混合成功与被拒调用，只声称成功的那个 ⇒ 放行；只声称被拒的那个 ⇒ 打回', () => {
    const ctx = makeCtx({
      messages: [
        assistantMsg([
          { id: 't1', name: 'Bash', arguments: { command: 'cargo check' } },
          { id: 't2', name: 'Bash', arguments: { command: 'npm test' } },
        ]),
        resultsMsg([okResult('t1'), deniedResult('t2')]),
      ],
    });

    const ok = runGoalEvidenceGate(makeCtx({ messages: ctx.messages }), makeCall({ commands: ['cargo check'] }));
    expect(ok.verdict).toBe('pass');

    const denied = runGoalEvidenceGate(makeCtx({ messages: ctx.messages }), makeCall({ commands: ['npm test'] }));
    expect(denied.verdict).toBe('bounce');
  });

  it('被拒绝的 Write 声称写过某文件（文件从未落盘）⇒ 打回', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evidence-gate-denied-write-'));
    const ctx = makeCtx({
      workingDirectory: dir,
      messages: [
        assistantMsg([{ id: 'w1', name: 'Write', arguments: { file_path: 'report.html', content: '<html></html>' } }]),
        resultsMsg([deniedResult('w1')]),
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ deliverables: ['report.html'] }));

    expect(result.verdict).toBe('bounce');
    expect(result.feedback).toContain('report.html');
  });

  it('被拒/失败的 Write 不进散落写入清单：stray 警告不出现（写入未发生）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evidence-gate-denied-stray-'));
    await writeFile(path.join(dir, 'app.html'), '<html></html>', 'utf8');
    const ctx = makeCtx({
      workingDirectory: dir,
      artifact: ArtifactState.forTest({
        declaredDeliverables: { finalArtifacts: ['app.html'], declaredAtMs: 1 },
      }),
      messages: [
        assistantMsg([
          { id: 'w1', name: 'Write', arguments: { file_path: 'app.html', content: 'x' } },
          { id: 'w2', name: 'Write', arguments: { file_path: 'stray.md', content: 'x' } },
        ]),
        resultsMsg([okResult('w1'), deniedResult('w2')]),
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ deliverables: ['app.html'] }));

    expect(result.verdict).toBe('pass');
    expect(result.reason).not.toContain('workspace hygiene warning');
  });

  it('成功执行的命令与写入原样放行（保护原有功能）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evidence-gate-ok-'));
    await writeFile(path.join(dir, 'report.html'), '<html></html>', 'utf8');
    const ctx = makeCtx({
      workingDirectory: dir,
      messages: [
        assistantMsg([
          { id: 't1', name: 'Bash', arguments: { command: 'npm test' } },
          { id: 'w1', name: 'Write', arguments: { file_path: 'report.html', content: '<html></html>' } },
        ]),
        resultsMsg([okResult('t1'), okResult('w1')]),
      ],
    });

    const result = runGoalEvidenceGate(ctx, makeCall({ deliverables: ['report.html'], commands: ['npm test'] }));

    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs.some((ref) => ref.kind === 'file')).toBe(true);
    expect(result.evidenceRefs.some((ref) => ref.kind === 'tool')).toBe(true);
  });
});
