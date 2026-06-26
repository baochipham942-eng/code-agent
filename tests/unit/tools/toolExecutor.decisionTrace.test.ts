import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { resetDecisionHistory, getDecisionHistory } from '../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

describe('ToolExecutor decision trace history', () => {
  beforeEach(() => {
    resetDecisionHistory();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
  });

  it('records a reviewable decision trace for classifier auto-approval', async () => {
    resolverState.getDefinition.mockReturnValue({
      name: 'Read',
      description: 'read test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'read',
    });
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('Read', { file_path: 'README.md' }, { sessionId: 's1' });

    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({
      toolName: 'Read',
      outcome: 'auto-approve',
    });
    expect(entry.decisionTrace).toMatchObject({
      toolName: 'Read',
      finalOutcome: 'allow',
      steps: [
        expect.objectContaining({
          layer: 'permission_classifier',
          rule: 'auto-approve',
          result: 'allow',
        }),
      ],
    });
  });

  it('records a deny trace for classifier-denied dangerous commands', async () => {
    resolverState.getDefinition.mockReturnValue({
      name: 'bash',
      description: 'shell test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'execute',
    });
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(true),
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('bash', { command: 'rm -rf *' }, { sessionId: 's1' });

    expect(result.success).toBe(false);
    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({
      toolName: 'bash',
      outcome: 'monitor-blocked',
    });
    expect(entry.decisionTrace?.finalOutcome).toBe('deny');
    expect(entry.decisionTrace?.steps[0]?.layer).toBe('guard_fabric');
  });
});
