// ============================================================================
// 已启用但未检查的 native 连接器：醒来前补一次 probe_access
// 真实 calendar 连接器模块 + 真实 ConnectorRegistry + 真实能力中心；只把 osascript 层换掉。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const harness = vi.hoisted(() => ({
  configDir: '',
  osascript: vi.fn(),
  registry: null as null | import('../../../../src/host/connectors/registry').ConnectorRegistry,
  logs: { info: [] as string[], warn: [] as string[] },
  runnerCalls: [] as Array<{ prompt: string }>,
}));
const mockSettings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => harness.configDir,
  getAgentsMdDir: () => ({ user: path.join(harness.configDir, 'agents') }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: (message: string) => { harness.logs.info.push(message); },
    warn: (message: string) => { harness.logs.warn.push(message); },
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    getSession: vi.fn(),
    createSession: async () => ({ id: `fw-${Date.now()}`, workingDirectory: undefined, messages: [] }),
    updateMessage: vi.fn(),
  }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => mockSettings.value, getServiceApiKey: () => undefined }),
}));
vi.mock('../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ provider: 'test', model: 'test' }),
}));
vi.mock('../../../../src/host/task', () => ({
  getTaskManager: () => ({ getOrCreateCurrentOrchestrator: () => undefined, setWorkingDirectory: vi.fn(), cleanup: vi.fn() }),
}));
vi.mock('../../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn().mockResolvedValue(undefined),
    recordEvent: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => [{ name: 'Read', permissionLevel: 'read' }],
}));
vi.mock('../../../../src/host/mcp/mcpClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/mcp/mcpClient')>();
  const client = new actual.MCPClient();
  return { ...actual, getMCPClient: () => client };
});
vi.mock('../../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({ ensureInitialized: vi.fn(), getAllSkills: () => [], refreshLibraries: vi.fn() }),
}));
vi.mock('../../../../src/host/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: vi.fn(), getLocalLibraries: () => [], enableSkill: vi.fn(), disableSkill: vi.fn(), isSkillEnabled: () => true,
  }),
}));
vi.mock('../../../../src/host/channels', () => ({
  getChannelManager: () => ({ getRegisteredPlugins: () => [], getAccounts: () => [] }),
}));
vi.mock('../../../../src/host/lightMemory/indexLoader', () => ({ getMemoryDir: () => '/tmp/code-agent-test-missing-memory-dir' }));
vi.mock('../../../../src/host/services/agentEngine', () => ({ getAgentEngineRegistry: () => ({ list: async () => [] }) }));
vi.mock('../../../../src/host/services/capabilities/remoteCapabilityRegistryService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/services/capabilities/remoteCapabilityRegistryService')>(),
  getRemoteCapabilityRegistryService: () => { throw new Error('单测不许落到真实远程注册表单例'); },
}));

// 只换 osascript 层：真实 calendar.ts 的 probe_access / readiness 全部照跑。
vi.mock('../../../../src/host/connectors/native/osascript', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/connectors/native/osascript')>(),
  runAppleScript: (lines: string[]) => harness.osascript(lines),
}));

// 注册表：真实 ConnectorRegistry（darwin 视角），由用例 configure。
vi.mock('../../../../src/host/connectors', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/connectors')>(),
  getConnectorRegistry: () => harness.registry,
}));

import { listConnectedSourceNames, enqueueFirstWake } from '../../../../src/host/services/roleAssets/roleFirstWake';
import { resolveWakeExternalDelta } from '../../../../src/host/services/roleAssets/roleWakeFindWork';
import { ConnectorRegistry } from '../../../../src/host/connectors/registry';
import { resetCalendarConnectorReadiness } from '../../../../src/host/connectors/native/calendar';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const previousDataDir = process.env.CODE_AGENT_DATA_DIR;

function enableCalendar(enabled: boolean): void {
  mockSettings.value = { connectors: { enabledNative: enabled ? ['calendar'] : [] } };
  harness.registry!.configure(enabled ? ['calendar'] : []);
}

beforeEach(async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  harness.configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-first-wake-nativeprobe-'));
  process.env.CODE_AGENT_DATA_DIR = harness.configDir;
  harness.logs.info.length = 0;
  harness.logs.warn.length = 0;
  harness.runnerCalls.length = 0;
  harness.osascript.mockReset().mockResolvedValue('工作\n家庭');
  harness.registry = new ConnectorRegistry('darwin');
  resetCalendarConnectorReadiness();
  mockSettings.value = {};
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', realPlatform);
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  await fs.rm(harness.configDir, { recursive: true, force: true });
});

describe('醒来前探测 unchecked 的 native 连接器', () => {
  it('(a) 已启用+未检查+已授权 → 计入已连接源，首次醒来 sourcesMode=connected', async () => {
    enableCalendar(true);
    expect(harness.registry!.get('calendar')!.getCachedStatus!().readiness).toBe('unchecked');

    await enqueueFirstWake('cal-role', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        return { finalOutput: '你好。\n```first_wake_suggestions\n[{"title":"看今日日程","prompt":"汇总我今天的日程"}]\n```' };
      },
    });
    const statePath = path.join(harness.configDir, 'roles', 'cal-role', 'first-wake.json');
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.readFile(statePath, 'utf-8'))).toMatchObject({ state: 'completed' });
    });
    const state = JSON.parse(await fs.readFile(statePath, 'utf-8')) as Record<string, unknown>;

    expect(state.sourcesMode).toBe('connected');
    expect(state.suggestions).toEqual([{ title: '看今日日程', prompt: '汇总我今天的日程' }]);
    expect(harness.runnerCalls[0]!.prompt).toContain('Calendar');
    expect(harness.registry!.get('calendar')!.getCachedStatus!().readiness).toBe('ready');
  });

  it('(b) 探测失败（未授权）→ 不计入，warn 点名连接器', async () => {
    enableCalendar(true);
    harness.osascript.mockRejectedValue(new Error('Not authorized to send Apple events to Calendar'));

    await expect(listConnectedSourceNames()).resolves.toEqual([]);
    expect(harness.logs.warn.some((line) => line.includes('connector: calendar') && line.includes('Not authorized'))).toBe(true);
    expect(harness.logs.info.some((line) => line.includes('probe-failed: [calendar]'))).toBe(true);
  });

  it('(c) 未启用（不在注册表）→ 不计入，日志说明 not enabled，且不碰 osascript', async () => {
    enableCalendar(false);

    await expect(listConnectedSourceNames()).resolves.toEqual([]);
    expect(harness.osascript).not.toHaveBeenCalled();
    expect(harness.logs.info.some((line) => /not enabled: \[calendar,/.test(line))).toBe(true);
  });

  it('(d) 已 ready 的连接器不再补探', async () => {
    enableCalendar(true);
    await harness.registry!.get('calendar')!.execute('probe_access', {});
    expect(harness.osascript).toHaveBeenCalledTimes(1);

    await expect(listConnectedSourceNames()).resolves.toEqual(['Calendar']);
    expect(harness.osascript).toHaveBeenCalledTimes(1);
  });

  it('(e) failed 的连接器不重探，也不计入', async () => {
    enableCalendar(true);
    harness.osascript.mockRejectedValue(new Error('denied'));
    await expect(harness.registry!.get('calendar')!.execute('probe_access', {})).rejects.toThrow('denied');
    expect(harness.registry!.get('calendar')!.getCachedStatus!().readiness).toBe('failed');
    expect(harness.osascript).toHaveBeenCalledTimes(1);

    harness.osascript.mockResolvedValue('工作');
    await expect(listConnectedSourceNames()).resolves.toEqual([]);
    expect(harness.osascript).toHaveBeenCalledTimes(1);
  });

  it('(f) 每日醒来 resolveWakeExternalDelta（不注入源名）也看到日历', async () => {
    enableCalendar(true);

    const delta = await resolveWakeExternalDelta({ roleId: 'cal-daily-role', hasProducts: false });
    expect(delta.sourceNames).toEqual(['Calendar']);
    expect(delta.section).toContain('Calendar');
    expect(harness.osascript).toHaveBeenCalledTimes(1);
  });
});
