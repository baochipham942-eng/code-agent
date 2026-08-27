import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
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
  createFileCheckpointIfNeeded: vi.fn(),
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

interface TraceStepLike { rule: string }

describe('ToolExecutor EXTERNAL 风险类打标进 decisionTrace', () => {
  const definitions = new Map([
    ['mail_send', {
      name: 'mail_send',
      description: 'send email test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    }],
    ['Write', {
      name: 'Write',
      description: 'write test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    }],
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
  });

  it('adds an external_side_effect step to the decision trace for mail_send', async () => {
    const requestPermission = vi.fn(async (_req: unknown) => true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    executor.setAuditEnabled(false);

    await executor.execute('mail_send', { subject: 'hi', to: ['a@b.com'] }, { sessionId: 's1' });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    const request = requestPermission.mock.calls[0][0] as { decisionTrace?: { steps: TraceStepLike[] } };
    const rules = (request.decisionTrace?.steps ?? []).map((s) => s.rule);
    expect(rules).toContain('external_side_effect');
  });

  it('does NOT add an external step for a plain outside-workspace Write', async () => {
    const requestPermission = vi.fn(async (_req: unknown) => true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    executor.setAuditEnabled(false);

    await executor.execute('Write', { file_path: '/Users/x/Desktop/out.txt', content: 'x' }, { sessionId: 's1' });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    const request = requestPermission.mock.calls[0][0] as { decisionTrace?: { steps: TraceStepLike[] } };
    const rules = (request.decisionTrace?.steps ?? []).map((s) => s.rule);
    expect(rules).not.toContain('external_side_effect');
  });

  it('危险删除审批携带 commandSafety 风险、目标路径和 host 盘点文件数', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-command-impact-'));
    const target = path.join(workspace, 'dist');
    fs.mkdirSync(path.join(target, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(target, 'a.js'), 'a');
    fs.writeFileSync(path.join(target, 'nested', 'b.js'), 'b');
    const requestPermission = vi.fn(async (_req: unknown) => false);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: workspace, forcePermissionHandler: true });
    executor.setAuditEnabled(false);

    try {
      await executor.execute('Bash', { command: 'rm -rf ./dist' }, { sessionId: 's1' });

      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(requestPermission.mock.calls[0][0]).toMatchObject({
        details: {
          commandRiskLevel: 'high',
          commandSecurityFlags: expect.arrayContaining(['recursive_delete_targeted']),
          affectedPath: target,
          affectedFileCount: 2,
        },
      });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
