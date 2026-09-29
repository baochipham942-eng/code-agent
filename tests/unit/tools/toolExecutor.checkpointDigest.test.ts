// N-CHECKPOINT-WRITETARGET 返修 r4：toolExecutor 的执行后摘要收口——后台启动的 Bash
// （run_in_background / 超时收养，bash.ts 的 meta.background）此刻返回、命令还在跑，
// 补摘要只会把之后的真实写入误标成人工编辑；普通执行与失败执行照常补（返修 r1 钉过）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

const checkpointState = vi.hoisted(() => ({
  createFileCheckpointIfNeeded: vi.fn(),
  finalizeCheckpointDigest: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: checkpointState.createFileCheckpointIfNeeded,
}));

vi.mock('../../../src/host/services/checkpoint', () => ({
  getFileCheckpointService: () => ({
    finalizeCheckpointDigest: checkpointState.finalizeCheckpointDigest,
  }),
}));

vi.mock('../../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
    shouldConfirm: () => false,
  }),
}));

vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');

describe('ToolExecutor checkpoint digest finalization', () => {
  const definitions = new Map([
    ['Bash', {
      name: 'Bash',
      description: 'bash test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'execute',
    }],
  ]);

  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => definitions.get(name));
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
    checkpointState.createFileCheckpointIfNeeded.mockReset();
    checkpointState.createFileCheckpointIfNeeded.mockResolvedValue([
      { checkpointId: 'ckpt-1', filePath: '/tmp/workbench/out.txt' },
    ]);
    checkpointState.finalizeCheckpointDigest.mockReset();
    checkpointState.finalizeCheckpointDigest.mockResolvedValue(true);
  });

  async function runBash(): Promise<void> {
    const requestPermission = vi.fn(async (_req: unknown) => true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    executor.setAuditEnabled(false);
    await executor.execute('Bash', { command: 'echo x > out.txt' }, { sessionId: 's1' });
  }

  it('finalizes checkpoint digests after a normal execution', async () => {
    await runBash();
    expect(checkpointState.finalizeCheckpointDigest).toHaveBeenCalledTimes(1);
    expect(checkpointState.finalizeCheckpointDigest).toHaveBeenCalledWith('ckpt-1', '/tmp/workbench/out.txt');
  });

  it('still finalizes digests after a failed run (Bash wrote before exiting non-zero)', async () => {
    resolverState.execute.mockResolvedValue({ success: false, error: 'exit 1' });
    await runBash();
    expect(checkpointState.finalizeCheckpointDigest).toHaveBeenCalledTimes(1);
  });

  it('skips digest finalization for a background start: the command is still running', async () => {
    // bash.ts 的 meta.background（run_in_background / 超时收养）——此刻摘要只是执行前
    // 状态，补上会让之后的真实写入在回退时被误标 human_edit；留空由回退按
    // missing_post_write_digest 如实披露
    resolverState.execute.mockResolvedValue({
      success: true,
      output: 'Background task started.',
      metadata: { background: true, taskId: 'task-1' },
    });
    await runBash();
    expect(checkpointState.finalizeCheckpointDigest).not.toHaveBeenCalled();
  });
});
