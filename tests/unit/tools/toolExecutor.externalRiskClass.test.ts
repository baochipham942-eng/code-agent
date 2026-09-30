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
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
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
import { register as registerPluginToolOrigin, unregister as unregisterPluginToolOrigin } from '../../../src/host/plugins/pluginToolOrigin';
import { getAuditLogger } from '../../../src/host/security';
import { getDecisionHistory } from '../../../src/host/security/decisionHistory';

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

  it('carries plugin and subagent attribution without changing the approval outcome', async () => {
    registerPluginToolOrigin('mail_send', 'example.plugin');
    try {
      const requestPermission = vi.fn(async () => false);
      const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
      executor.setAuditEnabled(false);

      const result = await executor.execute('mail_send', { subject: 'hi', to: ['a@b.com'] }, {
        sessionId: 's1',
        agentId: 'agent-child',
      });

      expect(result.success).toBe(false);
      expect(requestPermission.mock.calls[0]?.[0]).toMatchObject({
        agentId: 'agent-child',
        details: { pluginId: 'example.plugin' },
        decisionTrace: {
          finalOutcome: 'ask',
          steps: expect.arrayContaining([
            expect.objectContaining({ rule: 'plugin_origin', result: 'allow' }),
          ]),
        },
      });
    } finally {
      unregisterPluginToolOrigin('mail_send');
    }
  });

  it('writes pluginId to both success and error audit metadata', async () => {
    registerPluginToolOrigin('mail_send', 'example.plugin');
    const audit = getAuditLogger();
    const logToolUsage = vi.spyOn(audit, 'logToolUsage').mockImplementation(() => {});
    try {
      const executor = new ToolExecutor({ requestPermission: async () => true, workingDirectory: '/tmp/workbench' });
      await executor.execute('mail_send', { subject: 'hi', to: ['a@b.com'] }, { sessionId: 's1' });
      expect(logToolUsage.mock.calls.at(-1)?.[0]).toMatchObject({ metadata: { pluginId: 'example.plugin' } });

      resolverState.execute.mockRejectedValueOnce(new Error('boom'));
      await executor.execute('mail_send', { subject: 'hi', to: ['a@b.com'] }, { sessionId: 's1' });
      expect(logToolUsage.mock.calls.at(-1)?.[0]).toMatchObject({
        success: false,
        metadata: { pluginId: 'example.plugin' },
      });
    } finally {
      logToolUsage.mockRestore();
      unregisterPluginToolOrigin('mail_send');
    }
  });

  it('host Bash carries no pluginId while another tool is attributed', async () => {
    registerPluginToolOrigin('mail_send', 'example.plugin');
    const requestPermission = vi.fn(async () => false);
    try {
      const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
      executor.setAuditEnabled(false);
      await executor.execute('Bash', { command: 'plugin-ask-probe --marker' }, { sessionId: 'host-bash-plain' });
      expect(requestPermission).toHaveBeenCalledTimes(1);
      const request = requestPermission.mock.calls[0]?.[0] as {
        details?: { pluginId?: string };
        decisionTrace?: { steps: TraceStepLike[] };
      };
      expect(request.details?.pluginId).toBeUndefined();
      expect((request.decisionTrace?.steps ?? []).map((step) => step.rule)).not.toContain('plugin_origin');
    } finally {
      unregisterPluginToolOrigin('mail_send');
    }
  });

  it('keeps deny, ask, and forceConfirm outcomes unchanged when a tool is plugin-attributed', async () => {
    interface PermissionView {
      details?: { pluginId?: string };
      forceConfirm?: boolean;
      decisionTrace?: { finalOutcome: string; steps: TraceStepLike[] };
    }
    interface RunView {
      success: boolean;
      error?: string;
      asked: boolean;
      executed: boolean;
      forceConfirm: boolean;
      finalOutcome?: string;
      pluginId?: string;
      pluginStep: boolean;
      historyOutcome?: string;
      historyFinal?: string;
      historyPluginStep: boolean;
    }

    async function run(options: {
      tool: 'Bash' | 'mail_send';
      params: Record<string, unknown>;
      sessionId: string;
      attributed: boolean;
      readOnly?: boolean;
    }): Promise<RunView> {
      if (options.attributed) registerPluginToolOrigin(options.tool, 'example.plugin');
      const requestPermission = vi.fn(async () => false);
      const executor = new ToolExecutor({
        requestPermission,
        workingDirectory: '/tmp/workbench',
        ...(options.readOnly ? { permissionModeOverride: 'readOnly' as const } : {}),
      });
      executor.setAuditEnabled(false);
      const executedBefore = resolverState.execute.mock.calls.length;
      try {
        const result = await executor.execute(options.tool, options.params, { sessionId: options.sessionId });
        const request = requestPermission.mock.calls[0]?.[0] as PermissionView | undefined;
        const history = getDecisionHistory().getAll().filter((entry) => entry.sessionId === options.sessionId).at(-1);
        return {
          success: result.success,
          error: result.error,
          asked: requestPermission.mock.calls.length > 0,
          executed: resolverState.execute.mock.calls.length > executedBefore,
          forceConfirm: request?.forceConfirm === true,
          finalOutcome: request?.decisionTrace?.finalOutcome,
          pluginId: request?.details?.pluginId,
          pluginStep: (request?.decisionTrace?.steps ?? []).some((step) => step.rule === 'plugin_origin'),
          historyOutcome: history?.outcome,
          historyFinal: history?.decisionTrace?.finalOutcome,
          historyPluginStep: (history?.decisionTrace?.steps ?? []).some((step) => step.rule === 'plugin_origin'),
        };
      } finally {
        if (options.attributed) unregisterPluginToolOrigin(options.tool);
      }
    }

    function securityOutcome(view: RunView) {
      return {
        success: view.success,
        error: view.error,
        asked: view.asked,
        executed: view.executed,
        forceConfirm: view.forceConfirm,
        finalOutcome: view.finalOutcome,
        historyOutcome: view.historyOutcome,
        historyFinal: view.historyFinal,
      };
    }

    const denyCommand = { command: 'chmod 777 /tmp/plugin-deny-probe' };
    const askCommand = { command: 'plugin-ask-probe --marker' };
    const denyPlain = await run({ tool: 'Bash', params: denyCommand, sessionId: 'plugin-deny-plain', attributed: false });
    const denyPlugin = await run({ tool: 'Bash', params: denyCommand, sessionId: 'plugin-deny-plugin', attributed: true });
    expect(securityOutcome(denyPlugin)).toEqual(securityOutcome(denyPlain));
    expect(denyPlugin.success).toBe(false);
    expect(denyPlugin.error).toMatch(/^Denied:/);
    expect(denyPlugin.asked).toBe(false);
    expect(denyPlugin.executed).toBe(false);
    expect(denyPlugin.historyOutcome).toBe('classifier-deny');
    expect(denyPlugin.historyFinal).toBe('deny');
    expect(denyPlugin.historyPluginStep).toBe(true);
    expect(denyPlain.historyPluginStep).toBe(false);

    const askPlain = await run({ tool: 'Bash', params: askCommand, sessionId: 'plugin-ask-plain', attributed: false });
    const askPlugin = await run({ tool: 'Bash', params: askCommand, sessionId: 'plugin-ask-plugin', attributed: true });
    expect(securityOutcome(askPlugin)).toEqual(securityOutcome(askPlain));
    expect(askPlugin.success).toBe(false);
    expect(askPlugin.asked).toBe(true);
    expect(askPlugin.executed).toBe(false);
    expect(askPlugin.forceConfirm).toBe(false);
    expect(askPlugin.finalOutcome).toBe('ask');
    expect(askPlugin.pluginId).toBe('example.plugin');
    expect(askPlugin.pluginStep).toBe(true);
    expect(askPlain.pluginId).toBeUndefined();
    expect(askPlain.pluginStep).toBe(false);

    const mailArgs = { subject: 'hi', to: ['a@b.com'] };
    const confirmPlain = await run({
      tool: 'mail_send', params: mailArgs, sessionId: 'plugin-confirm-plain', attributed: false, readOnly: true,
    });
    const confirmPlugin = await run({
      tool: 'mail_send', params: mailArgs, sessionId: 'plugin-confirm-plugin', attributed: true, readOnly: true,
    });
    expect(securityOutcome(confirmPlugin)).toEqual(securityOutcome(confirmPlain));
    expect(confirmPlugin.success).toBe(false);
    expect(confirmPlugin.asked).toBe(true);
    expect(confirmPlugin.executed).toBe(false);
    expect(confirmPlugin.forceConfirm).toBe(true);
    expect(confirmPlugin.finalOutcome).toBe('ask');
    expect(confirmPlugin.pluginId).toBe('example.plugin');
    expect(confirmPlain.pluginId).toBeUndefined();
    expect(confirmPlain.forceConfirm).toBe(true);
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
