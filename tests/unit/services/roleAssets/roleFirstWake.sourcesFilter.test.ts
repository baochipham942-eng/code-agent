// ============================================================================
// Role First Wake 已连接源判据 — 真实能力中心清单路径（owner ruling 2026-10-17）
// ============================================================================
//
// 与 roleFirstWake.test.ts 的差别：那份 mock 掉 getCapabilityCenterService；这份走
// 真实 CapabilityCenterService.listCapabilities()，MCP 状态来自真实 MCPClient
// （addServer / registerInProcessServer），断言「内置源不算、用户自连才算」：
//   - 场景一：只有内置（deepwiki builtin + cloud 下发 + 真 in-process memory-kv /
//     code-index，全部 runtime=connected）→ sourcesMode=none；
//   - 变体 a：加一条 runtime scope 的用户 MCP（connected）→ connected；
//   - 变体 b：加一个 connected 的 native Mail 连接器 → connected。
// ②的夹具来源即本文件：listConnectedSourceNames → getCapabilityCenterService()
// .listCapabilities() → listMcpServers()/listConnectors()（真实映射产出 source.kind
// 与 tags，不手搓条目）。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const harness = vi.hoisted(() => ({
  configDir: '',
  runnerCalls: [] as Array<{ roleId: string; sessionId: string; prompt: string; allowedToolNames: string[] }>,
  resolveAgent: vi.fn(),
  allToolDefinitions: [] as Array<{ name: string; permissionLevel: string }>,
  automationRecordCreated: vi.fn(),
  automationRecordEvent: vi.fn(),
  mailConnected: false,
  client: null as null | import('../../../../src/host/mcp/mcpClient').MCPClient,
}));

const mockSessionManager = vi.hoisted(() => ({
  getCurrentSessionId: vi.fn(() => null),
  getSession: vi.fn(),
  createSession: vi.fn(),
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
    getSettings: () => mockSettings.value,
    // getDefaultMCPServers 会探 brave/github 服务 key；测试环境一律没有
    getServiceApiKey: () => undefined,
  }),
}));

vi.mock('../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ provider: 'test', model: 'test' }),
}));

vi.mock('../../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => undefined,
    setWorkingDirectory: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: harness.automationRecordCreated,
    recordEvent: harness.automationRecordEvent,
  }),
}));

vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: (roleId: string) => harness.resolveAgent(roleId),
}));

vi.mock('../../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => harness.allToolDefinitions.map((definition) => ({ ...definition })),
}));

// getMCPClient 指向真实 MCPClient 实例（每条用例新建），其余导出保持真实。
vi.mock('../../../../src/host/mcp/mcpClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/mcp/mcpClient')>(),
  getMCPClient: () => {
    if (!harness.client) throw new Error('MCPClient fixture not initialised');
    return harness.client;
  },
}));

// listCapabilities 的真实依赖逐个收窄：skills / channels / agent engines / memory
// recipes / 远程注册表全部置空，native 连接器状态由用例翻转。
vi.mock('../../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({
    ensureInitialized: vi.fn(),
    getAllSkills: () => [],
    refreshLibraries: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: vi.fn(),
    getLocalLibraries: () => [],
    enableSkill: vi.fn(),
    disableSkill: vi.fn(),
    isSkillEnabled: () => true,
  }),
}));

vi.mock('../../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({
    list: () => [
      {
        id: 'calendar',
        label: 'Calendar',
        getStatus: async () => ({ connected: false, readiness: 'ready' }),
      },
      {
        id: 'mail',
        label: 'Mail',
        getStatus: async () => ({ connected: harness.mailConnected, readiness: 'ready' }),
      },
    ],
  }),
}));

vi.mock('../../../../src/host/channels', () => ({
  getChannelManager: () => ({
    getRegisteredPlugins: () => [],
    getAccounts: () => [],
  }),
}));

vi.mock('../../../../src/host/lightMemory/indexLoader', () => ({
  getMemoryDir: () => '/tmp/code-agent-test-missing-memory-dir',
}));

vi.mock('../../../../src/host/services/agentEngine', () => ({
  getAgentEngineRegistry: () => ({ list: async () => [] }),
}));

// 与 capabilityCenterService.test.ts 同款护栏：单测不许落到真实远程注册表单例。
vi.mock('../../../../src/host/services/capabilities/remoteCapabilityRegistryService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/services/capabilities/remoteCapabilityRegistryService')>(),
  getRemoteCapabilityRegistryService: () => {
    throw new Error('单测不许落到真实 RemoteCapabilityRegistryService 单例');
  },
}));

import { enqueueFirstWake } from '../../../../src/host/services/roleAssets/roleFirstWake';
import { MCPClient } from '../../../../src/host/mcp/mcpClient';
import { getDefaultMCPServers } from '../../../../src/host/mcp/mcpDefaultServers';
import { createMemoryKVServer } from '../../../../src/host/mcp/servers/memoryKVServer';
import { createCodeIndexServer } from '../../../../src/host/mcp/servers/codeIndexServer';
import { getCapabilityCenterService } from '../../../../src/host/services/capabilities/capabilityCenterService';

// ----------------------------------------------------------------------------
// 夹具：真实 MCPClient + 真实清单路径
// ----------------------------------------------------------------------------

/**
 * 真实连接完成后 mcpClient 会把 state.status 置 'connected'（ensureConnected 内
 * state.status = 'connected'）。单测无网，经公开的 getServerState 拿到同一份状态
 * 对象镜像这一步——config/scope/tags 仍全部来自真实 addServer 路径。
 */
function markConnected(client: MCPClient, name: string): void {
  const state = client.getServerState(name);
  if (!state) throw new Error(`no server state for ${name}`);
  state.status = 'connected';
}

/** 内置基线：deepwiki（builtin scope，真实默认清单配置）+ 一条 cloud 下发 + 真 in-process 双子。 */
async function addBuiltinBaseline(client: MCPClient): Promise<void> {
  const deepwiki = getDefaultMCPServers().find((config) => config.name === 'deepwiki');
  if (!deepwiki) throw new Error('deepwiki not in default MCP servers');
  client.addServer({ ...deepwiki, scope: 'builtin' });
  markConnected(client, 'deepwiki');

  client.addServer({
    name: 'team-drive',
    type: 'http-streamable',
    serverUrl: 'https://mcp.example.test/mcp',
    enabled: true,
    scope: 'cloud',
  });
  markConnected(client, 'team-drive');

  await client.registerInProcessServer(createMemoryKVServer());
  await client.registerInProcessServer(createCodeIndexServer());
}

function suggestionsBlock(items: Array<{ title: string; prompt: string }>): string {
  return [
    '这是自我介绍，一共两三句。',
    '```first_wake_suggestions',
    JSON.stringify(items),
    '```',
  ].join('\n');
}

function statePath(roleId: string): string {
  return path.join(harness.configDir, 'roles', roleId, 'first-wake.json');
}

async function readState(roleId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(statePath(roleId), 'utf-8')) as Record<string, unknown>;
}

/** 跑一次首次醒来（fake runner 回固定产出），等到落盘后返回状态文件内容。 */
async function wakeAndReadState(roleId: string, finalOutput: string): Promise<Record<string, unknown>> {
  await enqueueFirstWake(roleId, {
    runner: async (input) => {
      harness.runnerCalls.push(input);
      return { finalOutput };
    },
  });
  await vi.waitFor(async () => { await expect(readState(roleId)).resolves.toMatchObject({ state: 'completed' }); });
  return readState(roleId);
}

const previousDataDir = process.env.CODE_AGENT_DATA_DIR;

beforeEach(async () => {
  harness.configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-first-wake-sources-'));
  // MemoryKVServer 经 platform app.getPath('userData') 定位存储文件；指到临时目录防污染。
  process.env.CODE_AGENT_DATA_DIR = harness.configDir;
  harness.runnerCalls.length = 0;
  harness.mailConnected = false;
  harness.automationRecordCreated.mockReset().mockResolvedValue(undefined);
  harness.automationRecordEvent.mockReset().mockResolvedValue(undefined);
  harness.allToolDefinitions = [
    { name: 'Read', permissionLevel: 'read' },
    { name: 'Write', permissionLevel: 'write' },
  ];
  mockSettings.value = {};
  mockSessionManager.getCurrentSessionId.mockReturnValue(null);
  mockSessionManager.getSession.mockReset();
  mockSessionManager.updateMessage.mockReset().mockResolvedValue(undefined);
  mockSessionManager.createSession.mockReset().mockImplementation(async () => (
    { id: `fw-${harness.runnerCalls.length + 1}-${Date.now()}`, workingDirectory: undefined, messages: [] }
  ));
  harness.resolveAgent.mockReset().mockImplementation(() => undefined);
  harness.client = new MCPClient();
  vi.clearAllMocks();
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  await fs.rm(harness.configDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// 场景
// ----------------------------------------------------------------------------

describe('已连接源判据（真实 CapabilityCenterService.listCapabilities 路径）', () => {
  it('真实映射钉子：memory-kv / code-index 以 runtime scope + in-process 标签露面，deepwiki 是 builtin', async () => {
    await addBuiltinBaseline(harness.client!);
    const inventory = await getCapabilityCenterService().listCapabilities();
    const byName = new Map(inventory.items.map((item) => [item.name, item]));

    expect(byName.get('memory-kv')).toMatchObject({
      kind: 'mcp_template',
      tags: expect.arrayContaining(['in-process']),
      source: { kind: 'runtime' },
      state: { runtime: 'connected' },
    });
    expect(byName.get('code-index')).toMatchObject({
      kind: 'mcp_template',
      tags: expect.arrayContaining(['in-process']),
      source: { kind: 'runtime' },
      state: { runtime: 'connected' },
    });
    expect(byName.get('deepwiki')).toMatchObject({
      kind: 'mcp_template',
      source: { kind: 'builtin' },
      state: { runtime: 'connected' },
    });
    expect(byName.get('team-drive')).toMatchObject({
      kind: 'mcp_template',
      source: { kind: 'cloud' },
      state: { runtime: 'connected' },
    });
    // 连接器基线：未连接的 native connector 不算
    expect(byName.get('Mail')).toMatchObject({
      kind: 'connector',
      state: { runtime: expect.any(String) },
    });
    expect((byName.get('Mail')!.state as { runtime: string }).runtime).not.toBe('connected');
  });

  it('只有内置源（builtin deepwiki + cloud + in-process 双子，全 connected）→ none，编造的建议被硬闸丢弃', async () => {
    await addBuiltinBaseline(harness.client!);
    const state = await wakeAndReadState('builtin-only-role', suggestionsBlock([
      { title: '编造', prompt: '不该落盘' },
    ]));

    expect(state.sourcesMode).toBe('none');
    expect(state.suggestions).toEqual([]);
    const prompt = harness.runnerCalls[0]!.prompt;
    expect(prompt).toContain('没有任何已连接的数据源');
    expect(prompt).not.toContain('deepwiki');
    expect(prompt).not.toContain('team-drive');
    expect(prompt).not.toContain('memory-kv');
    expect(prompt).not.toContain('code-index');
  });

  it('变体 a：加一条 runtime scope 的用户 MCP（connected）→ connected，prompt 只点名它', async () => {
    await addBuiltinBaseline(harness.client!);
    harness.client!.addServer({
      name: 'my-notes',
      type: 'http-streamable',
      serverUrl: 'https://notes.example.test/mcp',
      enabled: true,
      scope: 'runtime',
    });
    markConnected(harness.client!, 'my-notes');

    const state = await wakeAndReadState('user-mcp-role', suggestionsBlock([
      { title: '读我的笔记', prompt: '把最近笔记汇总给我' },
    ]));

    expect(state.sourcesMode).toBe('connected');
    expect(state.suggestions).toEqual([{ title: '读我的笔记', prompt: '把最近笔记汇总给我' }]);
    const prompt = harness.runnerCalls[0]!.prompt;
    expect(prompt).toContain('my-notes');
    expect(prompt).not.toContain('deepwiki');
    expect(prompt).not.toContain('memory-kv');
  });

  it('变体 b：加一个 connected 的 native Mail 连接器 → connected，prompt 点名 Mail', async () => {
    await addBuiltinBaseline(harness.client!);
    harness.mailConnected = true;

    const state = await wakeAndReadState('mail-connector-role', suggestionsBlock([
      { title: '汇总今日邮件', prompt: '帮我汇总今天的邮件' },
    ]));

    expect(state.sourcesMode).toBe('connected');
    const prompt = harness.runnerCalls[0]!.prompt;
    expect(prompt).toContain('Mail');
    expect(prompt).not.toContain('deepwiki');
    expect(prompt).not.toContain('memory-kv');
  });
});
