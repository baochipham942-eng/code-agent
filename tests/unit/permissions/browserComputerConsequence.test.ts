import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';

const resolverState = vi.hoisted(() => ({
  definition: undefined as ToolDefinition | undefined,
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: (name: string) => resolverState.definition?.name === name
      ? resolverState.definition
      : undefined,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { AgentFailureCode, HostReasonCode } from '../../../src/shared/contract';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';

function setSurfaceTool(name: string): void {
  resolverState.definition = {
    name,
    description: 'surface action test tool',
    outputSchema: { type: 'string' },
    inputSchema: { type: 'object', properties: {} },
    requiresPermission: true,
    permissionLevel: 'execute',
  };
}

describe('browser/computer consequence approval tier', () => {
  let permissionRequests: Array<Record<string, unknown>>;
  let executor: ToolExecutor;

  beforeEach(() => {
    resetPermissionModeManager();
    resetPolicyEngine();
    resolverState.definition = undefined;
    resolverState.execute.mockReset().mockResolvedValue({ success: true, output: 'ok' });
    permissionRequests = [];
    executor = new ToolExecutor({
      requestPermission: async (request) => {
        permissionRequests.push(request as unknown as Record<string, unknown>);
        return true;
      },
      workingDirectory: '/test/workspace',
    });
  });

  it('default: a browser action without external side effects runs without approval', async () => {
    setSurfaceTool('browser_action');
    const result = await executor.execute('browser_action', { action: 'click', selector: '#details' }, {});
    expect(result.success).toBe(true);
    expect(permissionRequests).toHaveLength(0);
  });

  it('default: an external-side-effect browser action requests approval', async () => {
    setSurfaceTool('browser_action');
    const result = await executor.execute('browser_action', {
      action: 'upload_file',
      selector: '#attachment',
      uploadFilePath: '/tmp/report.pdf',
    }, {});
    expect(result.success).toBe(true);
    expect(permissionRequests).toHaveLength(1);
  });

  it('default: a high-risk browser action is denied without prompting or dispatching', async () => {
    setSurfaceTool('browser_action');
    const result = await executor.execute('browser_action', { action: 'clear_cookies' }, {});
    expect(result).toMatchObject({
      success: false,
      metadata: {
        code: 'BROWSER_COMPUTER_HIGH_RISK_BLOCKED',
        failureCode: AgentFailureCode.PermissionDenied,
        hostReason: { code: HostReasonCode.PermissionHighRiskActionBlocked },
      },
    });
    expect(result.error).toBe(
      'Denied: High-risk browser/computer action is blocked by policy: browser_action.clear_cookies',
    );
    expect(permissionRequests).toHaveLength(0);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('permissions.ask 不能把浏览器高风险硬拒绝降级成可审批执行', async () => {
    setSurfaceTool('browser_action');
    getPolicyEngine().loadUserRules({ ask: ['browser_action'] });

    const result = await executor.execute('browser_action', { action: 'clear_cookies' }, {});

    expect(result).toMatchObject({
      success: false,
      metadata: { code: 'BROWSER_COMPUTER_HIGH_RISK_BLOCKED' },
    });
    expect(permissionRequests).toHaveLength(0);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'upload_file', uploadFilePath: '/tmp/report.pdf' },
    { action: 'write_clipboard', clipboardText: 'sensitive value' },
    { action: 'handle_dialog', dialogAction: 'accept', dialogPromptText: 'sensitive value' },
  ])('keeps existing upload/clipboard/dialog approval gates active: $action', async (params) => {
    setSurfaceTool('browser_action');
    expect((await executor.execute('browser_action', params, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(1);
  });

  it('covers stateful computer_use, Computer alias, and gui_agent at the same decision point', async () => {
    setSurfaceTool('computer_use');
    expect((await executor.execute('computer_use', { operation: 'observe' }, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(0);

    expect((await executor.execute('computer_use', { operation: 'act', stateId: 's1' }, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(1);

    setSurfaceTool('Computer');
    expect((await executor.execute('Computer', { action: 'screenshot' }, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(1);

    setSurfaceTool('gui_agent');
    expect((await executor.execute('gui_agent', { task: 'Open Settings' }, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(2);
  });

  it('fails closed when a surface action is absent from the catalog', async () => {
    setSurfaceTool('browser_action');
    const result = await executor.execute('browser_action', { action: 'future_action' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('not registered in the consequence catalog');
    expect(permissionRequests).toHaveLength(0);
  });

  it.each(['managed', 'relay'] as const)(
    'does not let skill pre-approval bypass hard denies for the %s engine',
    async (engine) => {
      setSurfaceTool('browser_action');

      const highRiskResult = await executor.execute(
        'browser_action',
        { action: 'clear_cookies', engine },
        { preApprovedTools: new Set(['browser_action']) },
      );
      expect(highRiskResult).toMatchObject({
        success: false,
        metadata: { code: 'BROWSER_COMPUTER_HIGH_RISK_BLOCKED' },
      });

      const unregisteredResult = await executor.execute(
        'browser_action',
        { action: 'future_action', engine },
        { preApprovedTools: new Set(['browser_action']) },
      );
      expect(unregisteredResult.success).toBe(false);
      expect(unregisteredResult.error).toContain('not registered in the consequence catalog');
      expect(permissionRequests).toHaveLength(0);
      expect(resolverState.execute).not.toHaveBeenCalled();
    },
  );

  it.each(['managed', 'relay'] as const)(
    'keeps skill pre-approval active for ordinary ask actions on the %s engine',
    async (engine) => {
      setSurfaceTool('browser_action');

      const result = await executor.execute(
        'browser_action',
        {
          action: 'upload_file',
          engine,
          selector: '#attachment',
          uploadFilePath: '/tmp/report.pdf',
        },
        { preApprovedTools: new Set(['browser_action']) },
      );

      expect(result.success).toBe(true);
      expect(permissionRequests).toHaveLength(0);
      expect(resolverState.execute).toHaveBeenCalledTimes(1);
    },
  );
});
