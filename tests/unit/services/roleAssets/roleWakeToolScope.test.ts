// ============================================================================
// 角色醒来的工具面：四条 run 都只能用声明过的工具，且永不带对外副作用工具。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { isToolDeniedByRunPolicy } from '../../../../src/host/tools/runToolPolicy';
import { isExternalSideEffectTool } from '../../../../src/host/tools/externalSideEffect';
import { toRoleBoundaryRunAllowlist } from '../../../../src/host/services/roleAssets/rolePersonalization';

const SCOPE_ROLE = 'scope-keeper';
const DENY_ROLE = 'boundary-empty';
const UNDECLARED_ROLE = 'undeclared-tools';
const DECLARED_TOOLS = ['Read', 'Bash', 'mail_send', 'mcp__lark__im.v1.message.create'];
const KEPT_TOOLS = ['Read', 'Bash'];
const OUTSIDE_TOOL = 'Write';
const EXTERNAL_DECLARED = ['mail_send', 'mcp__lark__im.v1.message.create'];
const DENY_ALL = ['__role_boundary_deny_all__'];
const SAMPLE_TABLE = [
  'Read',
  'Bash',
  'Write',
  'mail_send',
  'mcp__lark__im.v1.message.create',
  'mcp__lark__im.v1.message.list',
];

const harness = vi.hoisted(() => ({
  configDir: '',
  orchestratorPresent: true,
  sendMessage: vi.fn(),
  resolveAgent: vi.fn(),
  loops: [] as Array<{
    allowedToolNames?: string[];
    deniedToolNames?: string[];
    hasGoal: boolean;
  }>,
}));

const mockSessionManager = vi.hoisted(() => ({
  getCurrentSessionId: vi.fn(() => null),
  getSession: vi.fn(),
  createSession: vi.fn(),
  archiveSession: vi.fn(),
  updateMessage: vi.fn(),
}));

const mockSettings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => harness.configDir,
  getAgentsMdDir: () => ({ user: path.join(harness.configDir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => mockSessionManager,
}));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => mockSettings.value,
    getApiKey: () => '',
  }),
}));

vi.mock('../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({
    provider: 'xiaomi',
    model: 'mimo-v2.5-pro',
    apiKey: 'test',
    temperature: 0.7,
    maxTokens: 4096,
  }),
}));

vi.mock('../../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => (
      harness.orchestratorPresent ? { sendMessage: harness.sendMessage } : undefined
    ),
    setWorkingDirectory: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/roleAssets/roleWriteBack', () => ({
  runRoleWriteBack: vi.fn(async () => ({ written: [], skipped: [], historyAppended: true })),
}));

vi.mock('../../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
  }),
}));

vi.mock('@host/session/sessionEventService', () => ({
  getSessionEventService: () => ({ getEventsByType: vi.fn(() => []) }),
}));

vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: (roleId: string) => harness.resolveAgent(roleId),
}));

vi.mock('../../../../src/host/hooks', () => ({
  createHookManager: () => ({
    initialize: vi.fn(),
    hasHooksFor: () => false,
    triggerRoleWake: vi.fn(),
  }),
}));

vi.mock('../../../../src/cli/adapter', () => ({
  createCLIAgent: vi.fn(async () => {
    const config: {
      allowedToolNames?: string[];
      deniedToolNames?: string[];
      systemPrompt?: string;
      systemInstructions?: string[];
      maxIterations?: number;
      originKind?: string;
      goalContract?: unknown;
    } = {};
    return { getConfig: () => config };
  }),
}));

vi.mock('../../../../src/cli/bootstrap', () => ({
  createAgentLoop: vi.fn((config: {
    allowedToolNames?: string[];
    deniedToolNames?: string[];
    goalContract?: unknown;
  }) => {
    harness.loops.push({
      allowedToolNames: config.allowedToolNames ? [...config.allowedToolNames] : undefined,
      deniedToolNames: config.deniedToolNames ? [...config.deniedToolNames] : undefined,
      hasGoal: config.goalContract != null,
    });
    return { run: vi.fn(async () => undefined) };
  }),
}));

import { wakeRole } from '../../../../src/host/services/roleAssets/roleProactivity';
import { ensureRoleAssetDirs, appendRoleHistory } from '../../../../src/host/services/roleAssets/roleAssetService';
import { writeRolePersonalization } from '../../../../src/host/services/roleAssets/rolePersonalization';

const TODAY = new Date().toISOString().slice(0, 10);

function toolTable(policy: { allowedToolNames?: string[]; deniedToolNames?: string[] }): string[] {
  return SAMPLE_TABLE.filter((name) => !isToolDeniedByRunPolicy(policy, name));
}

function expectScopedAllowList(allowed: string[] | undefined): void {
  expect(allowed).toEqual(KEPT_TOOLS);
  expect(allowed).not.toContain(OUTSIDE_TOOL);
  for (const name of EXTERNAL_DECLARED) {
    expect(allowed).not.toContain(name);
  }
  expect(toolTable({ allowedToolNames: allowed })).toEqual(KEPT_TOOLS);
}

function expectDenyAll(allowed: string[] | undefined): void {
  expect(allowed).toEqual(toRoleBoundaryRunAllowlist([]));
  expect(allowed).toEqual(DENY_ALL);
  expect(toolTable({ allowedToolNames: allowed })).toEqual([]);
}

function primeSession(output: string, sessionId: string): void {
  mockSessionManager.createSession.mockResolvedValue({ id: sessionId, workingDirectory: undefined });
  mockSessionManager.getSession.mockResolvedValue({
    id: sessionId,
    messages: [{ id: 'm2', role: 'assistant', content: output, timestamp: 2 }],
  });
  harness.sendMessage.mockResolvedValue(undefined);
}

async function seedProduct(roleId: string): Promise<void> {
  await appendRoleHistory(roleId, {
    date: TODAY,
    artifactLabel: '调研报告',
    artifactRef: '/tmp/report.md',
    summary: '完成初稿',
  });
}

describe('role wake tool scope', () => {
  beforeEach(async () => {
    harness.configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-wake-toolscope-'));
    harness.orchestratorPresent = true;
    harness.loops.length = 0;
    mockSettings.value = { roleAssets: { proactivity: { defaultLevel: 'daily' } } };
    vi.clearAllMocks();
    await ensureRoleAssetDirs(SCOPE_ROLE);
    await ensureRoleAssetDirs(DENY_ROLE);
    await ensureRoleAssetDirs(UNDECLARED_ROLE);
    writeRolePersonalization(DENY_ROLE, { boundaries: { disallowExternalSending: true } });
    harness.resolveAgent.mockImplementation((roleId: string) => {
      if (roleId === SCOPE_ROLE) return { id: roleId, tools: DECLARED_TOOLS };
      if (roleId === DENY_ROLE) return { id: roleId, tools: ['mail_send', 'mcp__lark__im.v1.message.create'] };
      if (roleId === UNDECLARED_ROLE) return { id: roleId, tools: [] };
      return undefined;
    });
  });

  afterEach(async () => {
    await fs.rm(harness.configDir, { recursive: true, force: true });
  });

  it('headless CLI 醒来：声明外工具与对外副作用工具不进工具表，边界掏空时是拒绝全部哨兵', async () => {
    harness.orchestratorPresent = false;
    await seedProduct(SCOPE_ROLE);
    primeSession('检查完毕。<decision>report</decision>', 'cli-wake-scope');

    await wakeRole(SCOPE_ROLE, 'cadence');

    expect(harness.loops).toHaveLength(1);
    expect(harness.loops[0].hasGoal).toBe(false);
    expectScopedAllowList(harness.loops[0].allowedToolNames);

    harness.loops.length = 0;
    await seedProduct(DENY_ROLE);
    primeSession('检查完毕。<decision>report</decision>', 'cli-wake-deny');
    await wakeRole(DENY_ROLE, 'cadence');

    expect(harness.loops).toHaveLength(1);
    expectDenyAll(harness.loops[0].allowedToolNames);
  });

  it('headless CLI advance-goal：声明外工具与对外副作用工具不进工具表，边界掏空时是拒绝全部哨兵', async () => {
    harness.orchestratorPresent = false;
    await seedProduct(SCOPE_ROLE);
    primeSession(
      '推进。<goal>创建标记</goal><verify>test -f DONE.md</verify><decision>advance</decision>',
      'cli-goal-scope',
    );

    await wakeRole(SCOPE_ROLE, 'cadence');

    expect(harness.loops).toHaveLength(2);
    expect(harness.loops[1].hasGoal).toBe(true);
    expectScopedAllowList(harness.loops[1].allowedToolNames);

    harness.loops.length = 0;
    await seedProduct(DENY_ROLE);
    primeSession(
      '推进。<goal>创建标记</goal><verify>test -f DONE.md</verify><decision>advance</decision>',
      'cli-goal-deny',
    );
    await wakeRole(DENY_ROLE, 'cadence');

    expect(harness.loops).toHaveLength(2);
    expect(harness.loops[1].hasGoal).toBe(true);
    expectDenyAll(harness.loops[1].allowedToolNames);
  });

  it('orchestrator 醒来：声明外工具与对外副作用工具不进允许名单，边界掏空时是拒绝全部哨兵', async () => {
    await seedProduct(SCOPE_ROLE);
    primeSession('检查完毕。<decision>report</decision>', 'orch-wake-scope');

    await wakeRole(SCOPE_ROLE, 'cadence');

    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    const wakeOptions = harness.sendMessage.mock.calls[0][2] as { allowedToolNames?: string[] };
    expectScopedAllowList(wakeOptions.allowedToolNames);

    harness.sendMessage.mockClear();
    await seedProduct(DENY_ROLE);
    primeSession('检查完毕。<decision>report</decision>', 'orch-wake-deny');
    await wakeRole(DENY_ROLE, 'cadence');

    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    const denyOptions = harness.sendMessage.mock.calls[0][2] as { allowedToolNames?: string[] };
    expectDenyAll(denyOptions.allowedToolNames);
  });

  it('orchestrator advance-goal：声明外工具与对外副作用工具不进允许名单，边界掏空时是拒绝全部哨兵', async () => {
    await seedProduct(SCOPE_ROLE);
    primeSession(
      '推进。<goal>创建标记</goal><verify>test -f DONE.md</verify><decision>advance</decision>',
      'orch-goal-scope',
    );

    await wakeRole(SCOPE_ROLE, 'cadence');

    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    const goalOptions = harness.sendMessage.mock.calls[1][2] as { allowedToolNames?: string[]; goal?: { allowSwarm?: boolean } };
    expect(goalOptions.goal?.allowSwarm).toBe(false);
    expectScopedAllowList(goalOptions.allowedToolNames);

    harness.sendMessage.mockClear();
    await seedProduct(DENY_ROLE);
    primeSession(
      '推进。<goal>创建标记</goal><verify>test -f DONE.md</verify><decision>advance</decision>',
      'orch-goal-deny',
    );
    await wakeRole(DENY_ROLE, 'cadence');

    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    const denyGoal = harness.sendMessage.mock.calls[1][2] as { allowedToolNames?: string[]; goal?: unknown };
    expect(denyGoal.goal).toBeDefined();
    expectDenyAll(denyGoal.allowedToolNames);
  });

  it('未声明工具时不发明允许名单，仍用 deniedToolNames 拒绝对外副作用工具', async () => {
    harness.orchestratorPresent = false;
    await seedProduct(UNDECLARED_ROLE);
    primeSession('检查完毕。<decision>report</decision>', 'cli-undeclared');

    await wakeRole(UNDECLARED_ROLE, 'cadence');

    expect(harness.loops).toHaveLength(1);
    expect(harness.loops[0].allowedToolNames).toBeUndefined();
    const denied = harness.loops[0].deniedToolNames ?? [];
    expect(denied).toContain('mail_send');
    expect(denied.every((name) => isExternalSideEffectTool(name))).toBe(true);
    const openTable = toolTable({ deniedToolNames: denied });
    expect(openTable).not.toContain('mail_send');
    expect(openTable).toContain('Read');
    expect(openTable).toContain(OUTSIDE_TOOL);

    harness.resolveAgent.mockImplementation((roleId: string) => (
      roleId === UNDECLARED_ROLE ? { id: roleId, tools: undefined } : undefined
    ));
    harness.orchestratorPresent = true;
    harness.sendMessage.mockClear();
    primeSession('检查完毕。<decision>report</decision>', 'orch-undeclared');
    await wakeRole(UNDECLARED_ROLE, 'cadence');

    const options = harness.sendMessage.mock.calls[0][2] as {
      allowedToolNames?: string[];
      deniedToolNames?: string[];
    };
    expect(options.allowedToolNames).toBeUndefined();
    expect(options.deniedToolNames).toContain('mail_send');
    expect(options.deniedToolNames?.every((name) => isExternalSideEffectTool(name))).toBe(true);
  });
});
