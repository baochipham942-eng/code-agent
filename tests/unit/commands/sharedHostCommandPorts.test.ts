import { describe, expect, it, vi } from 'vitest';
import type { CommandContext, CommandDefinition, CommandOutput } from '../../../src/shared/commands/types';
import { btwCommand } from '../../../src/shared/commands/definitions/btwCommands';
import { doctorCommand } from '../../../src/shared/commands/definitions/doctorCommands';
import { resumeCommand } from '../../../src/shared/commands/definitions/sessionCommands';
import {
  connectorsCommand,
  mcpCommand,
  skillsCommand,
} from '../../../src/shared/commands/definitions/toolsCommands';
import {
  agentsCommand,
  contextCommand,
  costCommand,
  newCommands,
  permissionsCommand,
  pluginsCommand,
  statusCommand,
} from '../../../src/shared/commands/definitions/newCommands';

const guiDoctor = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../../src/renderer/services/doctorGuiSurface', () => ({
  runDoctorViaGuiSurface: async () => {
    guiDoctor.calls += 1;
    return {
      timestamp: 2,
      durationMs: 0,
      items: [{ category: 'environment', name: 'gui-node', status: 'pass', message: 'ok' }],
      summary: { pass: 1, warn: 0, fail: 0, skip: 0 },
    };
  },
}));

const doctorReport = {
  timestamp: 1,
  durationMs: 1500,
  items: [
    { category: 'environment', name: 'node', status: 'pass', message: 'ok' },
    { category: 'database', name: 'sqlite', status: 'warn', message: 'slow', suggestion: 'vacuum' },
    { category: 'mcp', name: 'srv', status: 'fail', message: 'dead' },
  ],
  summary: { pass: 1, warn: 1, fail: 1, skip: 0 },
};

function makeCtx(overrides: Record<string, unknown> = {}): { ctx: CommandContext; lines: string[] } {
  const lines: string[] = [];
  const output: CommandOutput = {
    info: (msg) => lines.push(`info:${msg}`),
    success: (msg) => lines.push(`success:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
  };
  return { lines, ctx: { surface: 'cli', output, ...overrides } as CommandContext };
}

function commandById(id: string): CommandDefinition {
  const command = newCommands.find((item) => item.id === id);
  if (!command) throw new Error(`command ${id} not registered`);
  return command;
}

function extensionOps(list: () => Promise<unknown[]> = async () => []) {
  return {
    list,
    install: async () => undefined,
    uninstall: async () => undefined,
    enable: async () => undefined,
    disable: async () => undefined,
    reload: async () => undefined,
    validate: async () => ({ valid: true, errors: [], warnings: [] }),
  };
}

describe('shared command host ports', () => {
  it('opens /btw on the CLI and GUI surfaces', () => {
    expect(btwCommand.surfaces).toEqual(['cli', 'gui']);
    expect(btwCommand.description).toBe('顺便问一句，不影响当前任务');
  });

  it('runs /doctor from the injected runner and keeps the CLI report text', async () => {
    const loaded = vi.fn(async () => ({ runDoctor: async () => doctorReport }));
    const { ctx, lines } = makeCtx({ loadDoctorRunner: loaded });
    const result = await doctorCommand.handler(ctx, []);
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(guiDoctor.calls).toBe(0);
    expect(result.success).toBe(false);
    expect(lines).toEqual([
      'info:/doctor running... 这可能需要几秒钟',
      'info:\n── Environment ──\n  ✓ node                         ok\n\n── Database ──\n  ⚠ sqlite                       slow\n      → vacuum\n\n── MCP ──\n  ✗ srv                          dead\n\nSummary: 1 pass / 1 warn / 1 fail / 0 skip   ⏱ 1.5s',
      'error:存在 1 项失败，建议查看上面的修复建议',
    ]);
  });

  it('reports a missing /doctor runner without leaving the handler', async () => {
    const { ctx, lines } = makeCtx();
    const result = await doctorCommand.handler(ctx, []);
    expect(result).toMatchObject({ success: false, message: 'loadDoctorRunner port is not available' });
    expect(lines).toContain('error:诊断失败：loadDoctorRunner port is not available');
  });

  it('keeps the GUI /doctor path on the renderer surface', async () => {
    const { ctx, lines } = makeCtx({
      surface: 'gui',
      loadDoctorRunner: async () => {
        throw new Error('cli runner must not load');
      },
    });
    const result = await doctorCommand.handler(ctx, []);
    expect(guiDoctor.calls).toBe(1);
    expect(result.success).toBe(true);
    expect(lines.join('\n')).toContain('gui-node');
    expect(lines).toContain('success:所有检查通过');
  });

  it('runs /skills /mcp /connectors from injected ops', async () => {
    const skills = makeCtx({
      skillOps: {
        listAvailable: async () => [{ name: 'docx' }, { name: 'excel' }],
        listMounted: async () => [{ skillName: 'docx', source: 'manual' }],
        listSelected: () => ['excel'],
      },
    });
    expect((await skillsCommand.handler(skills.ctx, [])).success).toBe(true);
    expect(skills.lines).toEqual([
      'info:Skills (2 available, 1 mounted, 1 selected)\n  Selected: excel\n  Mounted: docx',
    ]);

    const mcp = makeCtx({
      mcpOps: {
        getStatus: async () => ({ connectedServers: ['github'] }),
        listServerStates: async () => [
          { config: { name: 'github', enabled: true, type: 'stdio' }, status: 'connected', toolCount: 2, resourceCount: 0 },
        ],
        listTools: async () => [{ name: 'mcp__github__search' }],
      },
    });
    expect((await mcpCommand.handler(mcp.ctx, [])).success).toBe(true);
    expect(mcp.lines[0]).toContain('MCP (1 servers, 1 tools)');
    expect(mcp.lines[0]).toContain('+ github  connected/enabled  tools:2 resources:0');

    const connectors = makeCtx({
      connectorOps: {
        listStatuses: async () => [{ id: 'mail', label: 'Mail', connected: true, readiness: 'ready' }],
        listSelected: () => [],
      },
    });
    expect((await connectorsCommand.handler(connectors.ctx, [])).success).toBe(true);
    expect(connectors.lines).toEqual(['info:Connectors (1 total, 0 selected)\n  + mail  Mail ready']);
  });

  it('reports each tools service as unavailable when its port is missing', async () => {
    const skills = makeCtx();
    expect(await skillsCommand.handler(skills.ctx, [])).toMatchObject({ success: false });
    expect(skills.lines).toEqual(['info:Skill service not available']);

    const mcp = makeCtx();
    expect(await mcpCommand.handler(mcp.ctx, [])).toMatchObject({ success: false });
    expect(mcp.lines).toEqual(['info:MCP service not available']);

    const connectors = makeCtx();
    expect(await connectorsCommand.handler(connectors.ctx, [])).toMatchObject({ success: false });
    expect(connectors.lines).toEqual(['info:Connector service not available']);
  });

  it('runs /btw from injected side-chat ports', async () => {
    const seen: string[] = [];
    const { ctx, lines } = makeCtx({
      agent: {
        getHistory: () => [{ role: 'user', content: 'hi' }],
        getConfig: () => ({ modelConfig: { provider: 'p', model: 'm' }, workingDirectory: '/tmp/work' }),
      },
      loadReadOnlySideChat: async () => ({
        runReadOnlySideChat: async (_deps: object, question: string) => {
          seen.push(question);
          return 'side-answer';
        },
      }),
      loadToolResolver: async () => ({ getToolResolver: () => ({ id: 'resolver' }) }),
      loadSubagentExecutor: async () => ({ getSubagentExecutor: () => ({ id: 'executor' }) }),
    });
    const result = await btwCommand.handler(ctx, ['hello']);
    expect(result).toEqual({ success: true });
    expect(seen).toEqual(['hello']);
    expect(lines).toEqual(['info:（侧聊·只读）思考中…', 'info:side-answer']);
  });

  it('opens a GUI /btw question without writing output or loading host ports', async () => {
    const openSideChat = vi.fn();
    const load = vi.fn();
    const { ctx, lines } = makeCtx({
      surface: 'gui',
      openSideChat,
      loadReadOnlySideChat: load,
      loadToolResolver: load,
      loadSubagentExecutor: load,
    });
    const result = await btwCommand.handler(ctx, ['旁边问一句']);
    expect(result).toEqual({ success: true });
    expect(openSideChat).toHaveBeenCalledWith('旁边问一句');
    expect(lines).toEqual([]);
    expect(load).not.toHaveBeenCalled();

    const empty = makeCtx({ surface: 'gui', openSideChat, loadReadOnlySideChat: load });
    expect(await btwCommand.handler(empty.ctx, ['  '])).toMatchObject({ success: false, message: 'missing question' });
    expect(empty.lines).toEqual([]);
    expect(openSideChat).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty /btw question and a missing agent before loading ports', async () => {
    const load = vi.fn();
    const empty = makeCtx({ loadReadOnlySideChat: load, loadToolResolver: load, loadSubagentExecutor: load });
    expect(await btwCommand.handler(empty.ctx, [])).toMatchObject({ success: false, message: 'missing question' });
    expect(empty.lines).toEqual(['warn:用法：/btw <你的问题>']);

    const noAgent = makeCtx({ loadReadOnlySideChat: load });
    expect(await btwCommand.handler(noAgent.ctx, ['hello'])).toMatchObject({ success: false, message: 'no agent context' });
    expect(noAgent.lines).toEqual(['error:/btw 当前仅在 CLI 聊天会话中可用']);
    expect(load).not.toHaveBeenCalled();
  });

  it('reports a missing /btw port as a side-chat failure', async () => {
    const { ctx, lines } = makeCtx({
      agent: {
        getHistory: () => [],
        getConfig: () => ({ modelConfig: { provider: 'p', model: 'm' }, workingDirectory: '/tmp/work' }),
      },
    });
    const result = await btwCommand.handler(ctx, ['hello']);
    expect(result.success).toBe(false);
    expect(result.message).toContain('port is not available');
    expect(lines[0]).toContain('error:侧聊失败：');
  });

  it('resumes from the injected recovery port and skips it for a named session', async () => {
    const checkPreviousSession = vi.fn(async () => 'recovered text');
    const injectContext = vi.fn();
    const recoveryLoads = vi.fn(async () => ({
      getSessionRecoveryService: () => ({ checkPreviousSession }),
    }));
    const resumed = makeCtx({
      agent: { getSessionId: () => 'sid', injectContext },
      getSessionManager: () => ({
        getSession: async () => ({ workingDirectory: '/tmp/work' }),
      }),
      loadSessionRecovery: recoveryLoads,
    });
    const result = await resumeCommand.handler(resumed.ctx, []);
    expect(result.success).toBe(true);
    expect(checkPreviousSession).toHaveBeenCalledWith('sid', '/tmp/work');
    expect(injectContext).toHaveBeenCalledWith('recovered text');
    expect(resumed.lines).toEqual(['success:Previous session context injected. Ask me to continue the previous task.']);

    const namedLoads = vi.fn();
    const named = makeCtx({
      agent: { getSessionId: () => 'sid', injectContext: vi.fn() },
      getSessionManager: () => ({
        getSession: async () => ({ id: 'abc', title: 'Old', messages: [{ role: 'user', content: 'task' }] }),
      }),
      loadSessionRecovery: namedLoads,
    });
    expect((await resumeCommand.handler(named.ctx, ['abc'])).success).toBe(true);
    expect(namedLoads).not.toHaveBeenCalled();
  });

  it('reports no active session and a missing recovery port without throwing', async () => {
    const load = vi.fn();
    const idle = makeCtx({ agent: { getSessionId: () => null }, loadSessionRecovery: load });
    expect(await resumeCommand.handler(idle.ctx, [])).toMatchObject({ success: false });
    expect(idle.lines).toEqual(['error:No active session']);
    expect(load).not.toHaveBeenCalled();

    const missing = makeCtx({ agent: { getSessionId: () => 'sid' } });
    const result = await resumeCommand.handler(missing.ctx, []);
    expect(result).toMatchObject({ success: false, message: 'loadSessionRecovery port is not available' });
    expect(missing.lines).toEqual(['error:Resume failed: loadSessionRecovery port is not available']);
  });

  it('renders /agents from injected session and history ports', async () => {
    const { ctx, lines } = makeCtx({
      loadSessionStateManager: async () => ({
        getSessionStateManager: () => ({
          getRunning: () => [{ sessionId: 's1', status: 'running' }],
          getActiveAgentCount: () => 2,
        }),
      }),
      loadAgentHistory: async () => ({
        getRecentAgentHistory: async () => [{
          name: 'writer',
          role: 'edit',
          status: 'completed',
          durationMs: 500,
          tokenUsage: { input: 10, output: 20 },
          resultPreview: 'done',
        }],
      }),
    });
    expect((await agentsCommand.handler(ctx, [])).success).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain('● s1  agents: 2  status: running');
    expect(text).toContain('writer (edit)');
    expect(text).toContain('done');
  });

  it('keeps /agents fallback text when either port is missing', async () => {
    const historyOnly = makeCtx({
      loadAgentHistory: async () => ({ getRecentAgentHistory: async () => [] }),
    });
    expect((await agentsCommand.handler(historyOnly.ctx, [])).success).toBe(true);
    expect(historyOnly.lines[0]).toContain('运行中');
    expect(historyOnly.lines[0]).toContain('(无法获取)');
    expect(historyOnly.lines[0]).toContain('(无历史记录)');

    const neither = makeCtx();
    expect((await agentsCommand.handler(neither.ctx, [])).success).toBe(true);
    expect(neither.lines[0]).toContain('(无法获取)');
    expect(neither.lines[0]).toContain('最近完成');
  });

  it('adds a /status context line only when the health port loads', async () => {
    const agent = {
      getConfig: () => ({ modelConfig: { provider: 'p', model: 'm' } }),
      getHistory: () => [],
      getSessionId: () => 'sid',
      getTokenUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    };
    const present = makeCtx({
      agent,
      loadContextHealth: async () => ({
        getContextHealthService: () => ({
          getLatest: () => ({
            lastUpdated: 5,
            currentTokens: 10,
            maxTokens: 100,
            usagePercent: 10,
            estimatedTurnsRemaining: 4,
            breakdown: { systemPrompt: 1, messages: 2, toolResults: 7 },
          }),
        }),
      }),
    });
    expect((await statusCommand.handler(present.ctx, [])).success).toBe(true);
    expect(present.lines[0]).toContain('Context:  10.0% (~4 turns remaining)');

    const missing = makeCtx({ agent });
    expect((await statusCommand.handler(missing.ctx, [])).success).toBe(true);
    expect(missing.lines[0]).not.toContain('Context:');
  });

  it('lists plugins from CLI extensionOps and keeps both missing-port errors', async () => {
    const cli = makeCtx({ extensionOps: extensionOps() });
    expect(await pluginsCommand.handler(cli.ctx, [])).toMatchObject({ success: true, data: { count: 0 } });
    expect(cli.lines).toEqual(['info:No extensions installed']);

    const missingCli = makeCtx();
    expect(await pluginsCommand.handler(missingCli.ctx, [])).toMatchObject({
      success: false,
      message: 'getExtensionOpsService is not available',
    });
    expect(missingCli.lines).toEqual(['error:Plugin operation failed: getExtensionOpsService is not available']);

    const missingGui = makeCtx({ surface: 'gui' });
    expect(await pluginsCommand.handler(missingGui.ctx, [])).toMatchObject({
      success: false,
      message: 'Extension operations are not wired for GUI commands',
    });
    expect(missingGui.lines).toEqual(['error:Plugin operation failed: Extension operations are not wired for GUI commands']);
  });

  it('appends a /cost budget line only when the budget port loads', async () => {
    const agent = {
      getCostInfo: () => ({ inputTokens: 1000, outputTokens: 0, model: 'missing-model', provider: 'p' }),
    };
    const present = makeCtx({
      agent,
      loadBudgetService: async () => ({
        getBudgetService: () => ({
          checkBudget: () => ({ maxBudget: 2, currentCost: 0.5, usagePercentage: 25 }),
        }),
      }),
    });
    expect((await costCommand.handler(present.ctx, [])).success).toBe(true);
    expect(present.lines[0]).toContain('Budget:');

    const missing = makeCtx({ agent });
    expect((await costCommand.handler(missing.ctx, [])).success).toBe(true);
    expect(missing.lines[0]).toContain('Cost (session)');
    expect(missing.lines[0]).not.toContain('Budget:');
  });

  it('renders /context from the health port and keeps compression optional', async () => {
    const health = {
      lastUpdated: 5,
      currentTokens: 1500,
      maxTokens: 8000,
      usagePercent: 18.75,
      estimatedTurnsRemaining: 3,
      breakdown: { systemPrompt: 100, messages: 400, toolResults: 1000 },
    };
    const present = makeCtx({
      loadContextHealth: async () => ({ getContextHealthService: () => ({ getLatest: () => health }) }),
      loadAutoCompressor: async () => ({
        getAutoCompressor: () => ({ getStats: () => ({ compressionCount: 2, totalSavedTokens: 30 }) }),
      }),
    });
    expect((await contextCommand.handler(present.ctx, [])).success).toBe(true);
    expect(present.lines[0]).toContain('Context');
    expect(present.lines[0]).toContain('Compressed: 2 times');

    const noCompressor = makeCtx({
      loadContextHealth: async () => ({ getContextHealthService: () => ({ getLatest: () => health }) }),
    });
    expect((await contextCommand.handler(noCompressor.ctx, [])).success).toBe(true);
    expect(noCompressor.lines[0]).not.toContain('Compressed:');

    const missing = makeCtx();
    const result = await contextCommand.handler(missing.ctx, []);
    expect(result).toMatchObject({ success: false, message: 'loadContextHealth port is not available' });
    expect(missing.lines).toEqual(['error:Context command failed: loadContextHealth port is not available']);
  });

  it('renders /permissions from injected ports and falls back when they are missing', async () => {
    const present = makeCtx({
      loadPermissionModes: async () => ({
        getPermissionModeManager: () => ({
          getMode: () => 'strict',
          getModeConfig: () => ({ description: 'asks first' }),
        }),
      }),
      loadExecPolicy: async () => ({
        getExecPolicyStore: () => ({
          getRules: () => [{ pattern: ['git', 'status'], createdAt: 1, source: 'builtin', decision: 'allow' }],
        }),
      }),
      loadDecisionHistory: async () => ({
        getDecisionHistory: () => ({
          getRecent: () => [{
            timestamp: 1_700_000_000_000,
            toolName: 'shell',
            summary: 'list files',
            outcome: 'allow',
            reason: 'rule',
            durationMs: 3,
          }],
          getAll: () => [1],
        }),
      }),
    });
    expect((await permissionsCommand.handler(present.ctx, [])).success).toBe(true);
    const text = present.lines[0];
    expect(text).toContain('Mode:     strict — asks first');
    expect(text).toContain('git status *');
    expect(text).toContain('shell(list files)');

    const missing = makeCtx();
    expect((await permissionsCommand.handler(missing.ctx, [])).success).toBe(true);
    expect(missing.lines[0]).toContain('Mode:     default');
    expect(missing.lines[0]).toContain('Exec Policy: (not initialized)');
    expect(missing.lines[0]).toContain('Recent Decisions: (not available)');
    expect(missing.lines.some((line) => line.startsWith('error:'))).toBe(false);
  });

  it('reports a missing background-task port from /ps and /stop, and still returns /stop usage first', async () => {
    const ps = commandById('ps');
    const stop = commandById('stop');
    const psMissing = makeCtx();
    expect(await ps.handler(psMissing.ctx, [])).toMatchObject({
      success: false,
      message: 'loadBackgroundTasks port is not available',
    });
    expect(psMissing.lines).toEqual(['error:loadBackgroundTasks port is not available']);

    const usageLoad = vi.fn();
    const usage = makeCtx({ loadBackgroundTasks: usageLoad });
    expect(await stop.handler(usage.ctx, [])).toEqual({ success: false, message: '用法: /stop <taskId 或前缀>' });
    expect(usage.lines).toEqual([]);
    expect(usageLoad).not.toHaveBeenCalled();

    const stopMissing = makeCtx();
    expect(await stop.handler(stopMissing.ctx, ['abc'])).toMatchObject({
      success: false,
      message: 'loadBackgroundTasks port is not available',
    });
    expect(stopMissing.lines).toEqual(['error:loadBackgroundTasks port is not available']);
  });

  it('lets a loaded background-task getter throw out of /ps', async () => {
    const ps = commandById('ps');
    const { ctx } = makeCtx({
      loadBackgroundTasks: async () => ({
        getAllBackgroundTasks: () => {
          throw new Error('boom-tasks');
        },
        killBackgroundTask: async () => ({ success: true }),
      }),
    });
    await expect(ps.handler(ctx, [])).rejects.toThrow('boom-tasks');
  });
});
