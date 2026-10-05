// ============================================================================
// Role First Wake Tests — 新角色首次醒来（入队幂等 / 工具面只读 / 提示词变体 /
// 建议解析容错 / 跳过封口 / 可见性 / 默认执行器两分支）
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const harness = vi.hoisted(() => ({
  configDir: '',
  runnerCalls: [] as Array<{ roleId: string; sessionId: string; prompt: string; allowedToolNames: string[] }>,
  resolveAgent: vi.fn(),
  listCapabilities: vi.fn(),
  allToolDefinitions: [] as Array<{ name: string; permissionLevel: string }>,
  automationRecordCreated: vi.fn(),
  automationRecordEvent: vi.fn(),
  sendMessage: vi.fn(),
  orchestratorPresent: true,
  loops: [] as Array<{ allowedToolNames?: string[] }>,
  sessionSeq: 0,
}));

const mockSessionManager = vi.hoisted(() => ({
  getCurrentSessionId: vi.fn(() => null),
  getSession: vi.fn(),
  createSession: vi.fn(),
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
  }),
}));

vi.mock('../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ provider: 'test', model: 'test' }),
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

vi.mock('../../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: harness.automationRecordCreated,
    recordEvent: harness.automationRecordEvent,
  }),
}));

vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: (roleId: string) => harness.resolveAgent(roleId),
}));

vi.mock('../../../../src/host/services/capabilities/capabilityCenterService', () => ({
  getCapabilityCenterService: () => ({ listCapabilities: harness.listCapabilities }),
}));

vi.mock('../../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => harness.allToolDefinitions.map((definition) => ({ ...definition })),
}));

vi.mock('../../../../src/cli/adapter', () => ({
  createCLIAgent: vi.fn(async () => {
    const config: { allowedToolNames?: string[]; systemPrompt?: string } = {};
    return { getConfig: () => config };
  }),
}));

vi.mock('../../../../src/cli/bootstrap', () => ({
  createAgentLoop: vi.fn((config: { allowedToolNames?: string[] }) => {
    harness.loops.push({ allowedToolNames: config.allowedToolNames ? [...config.allowedToolNames] : undefined });
    return { run: vi.fn(async () => undefined) };
  }),
}));

import {
  enqueueFirstWake,
  skipFirstWake,
  getFirstWakeSnapshot,
} from '../../../../src/host/services/roleAssets/roleFirstWake';
import { toRoleBoundaryRunAllowlist } from '../../../../src/host/services/roleAssets/rolePersonalization';

// ----------------------------------------------------------------------------
// 夹具
// ----------------------------------------------------------------------------

const DENY_ALL = toRoleBoundaryRunAllowlist([]);

/** 默认工具表（mock 的 getAllToolDefinitions）：read 三件 + write/execute/network 各一 + MCP 读写各一 */
const DEFAULT_TOOL_DEFINITIONS = [
  { name: 'Read', permissionLevel: 'read' },
  { name: 'Grep', permissionLevel: 'read' },
  { name: 'Glob', permissionLevel: 'read' },
  { name: 'Write', permissionLevel: 'write' },
  { name: 'Bash', permissionLevel: 'execute' },
  { name: 'WebSearch', permissionLevel: 'network' },
  { name: 'mail_send', permissionLevel: 'write' },
  { name: 'mcp__lark__docs.list', permissionLevel: 'read' },
  { name: 'mcp__lark__docs.update', permissionLevel: 'write' },
];

function connectedInventory(): { items: Array<{ kind: string; name: string; state: { runtime: string } }> } {
  return {
    items: [
      { kind: 'connector', name: '日历', state: { runtime: 'connected' } },
      { kind: 'mcp_template', name: 'Lark 文档', state: { runtime: 'connected' } },
      // 非目标条目：skill / 未连接的 mcp / 未连接的 connector 都不算已连接源
      { kind: 'skill', name: 'ppt 技能', state: { runtime: 'connected' } },
      { kind: 'mcp_template', name: '未连接 mcp', state: { runtime: 'lazy' } },
      { kind: 'connector', name: '未连接连接器', state: { runtime: 'not_configured' } },
    ],
  };
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

function settle(ms = 25): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

beforeEach(async () => {
  harness.configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-first-wake-'));
  harness.runnerCalls.length = 0;
  harness.sessionSeq = 0;
  harness.orchestratorPresent = true;
  harness.loops.length = 0;
  harness.sendMessage.mockReset();
  harness.automationRecordCreated.mockReset().mockResolvedValue(undefined);
  harness.automationRecordEvent.mockReset().mockResolvedValue(undefined);
  harness.listCapabilities.mockReset().mockResolvedValue({ items: [] });
  harness.allToolDefinitions = DEFAULT_TOOL_DEFINITIONS.map((definition) => ({ ...definition }));
  mockSettings.value = {};
  mockSessionManager.getCurrentSessionId.mockReturnValue(null);
  mockSessionManager.getSession.mockReset();
  mockSessionManager.createSession.mockReset().mockImplementation(async () => {
    harness.sessionSeq += 1;
    return { id: `fw-${harness.sessionSeq}`, workingDirectory: undefined, messages: [] };
  });
  harness.resolveAgent.mockReset().mockImplementation(() => undefined);
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(harness.configDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// 入队 + 完整链路（fake runner）
// ----------------------------------------------------------------------------

describe('enqueueFirstWake → runFirstWake 完整链路', () => {
  it('connected 源在场：prompt 点名已连接源并要求建议块；状态机走完并落建议', async () => {
    harness.listCapabilities.mockResolvedValue(connectedInventory());
    harness.resolveAgent.mockImplementation((roleId: string) => (
      roleId === 'news-watcher' ? { id: roleId, tools: ['Read', 'Write', 'Bash', 'mail_send', 'WebSearch'] } : undefined
    ));

    const result = await enqueueFirstWake('news-watcher', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        return { finalOutput: suggestionsBlock([{ title: '总结本周日历', prompt: '帮我总结本周的日程安排' }]) };
      },
    });
    expect(result).toEqual({ enqueued: true });

    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });
    const input = harness.runnerCalls[0]!;
    expect(input.roleId).toBe('news-watcher');
    expect(input.sessionId).toMatch(/^fw-\d+$/);
    // prompt：点名已连接源（只有真正 connected 的 connector/mcp），要求建议块，声明语言规则
    expect(input.prompt).toContain('日历');
    expect(input.prompt).toContain('Lark 文档');
    expect(input.prompt).not.toContain('ppt 技能');
    expect(input.prompt).not.toContain('未连接 mcp');
    expect(input.prompt).toContain('first_wake_suggestions');
    expect(input.prompt).toContain('用用户的语言回答');
    // 工具面：声明 − 对外副作用（mail_send）− 非只读（Write/Bash/WebSearch）= 只剩 Read
    expect(input.allowedToolNames).toEqual(['Read']);

    await vi.waitFor(async () => { await expect(readState('news-watcher')).resolves.toMatchObject({ state: 'completed' }); });
    const state = await readState('news-watcher');
    expect(state.sourcesMode).toBe('connected');
    expect(state.sessionId).toBe(input.sessionId);
    expect(state.suggestions).toEqual([{ title: '总结本周日历', prompt: '帮我总结本周的日程安排' }]);
  });

  it('可见性：建 role_wake 自动化记录（trigger=first_wake，无 cadenceLabel），完成后 recordEvent 收尾', async () => {
    await enqueueFirstWake('visible-role', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        return { finalOutput: suggestionsBlock([]) };
      },
    });
    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });

    expect(harness.automationRecordCreated).toHaveBeenCalledWith(expect.objectContaining({
      type: 'role_wake',
      status: 'running',
      title: 'visible-role · first wake',
      sourceRefId: harness.runnerCalls[0]!.sessionId,
      resultSessionId: harness.runnerCalls[0]!.sessionId,
      config: { roleId: 'visible-role', trigger: 'first_wake' },
    }));
    expect(harness.automationRecordCreated.mock.calls[0]![0]).not.toHaveProperty('cadenceLabel');

    await vi.waitFor(() => {
      expect(harness.automationRecordEvent).toHaveBeenCalledWith(expect.objectContaining({
        automationId: `role_wake:${harness.runnerCalls[0]!.sessionId}`,
        event: 'completed',
        status: 'completed',
      }));
    });
  });
});

// ----------------------------------------------------------------------------
// 入队幂等（并发 / 顺序 / 终态不重入）
// ----------------------------------------------------------------------------

describe('enqueueFirstWake 幂等', () => {
  it('并发 5 连发：只有一个 enqueued，其余 exists，runner 总共一次', async () => {
    const results = await Promise.all([
      enqueueFirstWake('conc-role', { runner: async (input) => { harness.runnerCalls.push(input); return { finalOutput: '介绍' }; } }),
      enqueueFirstWake('conc-role', { runner: async (input) => { harness.runnerCalls.push(input); return { finalOutput: '介绍' }; } }),
      enqueueFirstWake('conc-role', { runner: async (input) => { harness.runnerCalls.push(input); return { finalOutput: '介绍' }; } }),
      enqueueFirstWake('conc-role', { runner: async (input) => { harness.runnerCalls.push(input); return { finalOutput: '介绍' }; } }),
      enqueueFirstWake('conc-role', { runner: async (input) => { harness.runnerCalls.push(input); return { finalOutput: '介绍' }; } }),
    ]);
    expect(results.filter((r) => r.enqueued)).toHaveLength(1);
    expect(results.filter((r) => r.reason === 'exists')).toHaveLength(4);

    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });
    await settle();
    expect(harness.runnerCalls).toHaveLength(1);
  });

  it('顺序二次入队（run 进行中）：返回 exists，runner 仍只有一次', async () => {
    let releaseRun: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseRun = resolve; });
    const first = await enqueueFirstWake('seq-role', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        await gate;
        return { finalOutput: suggestionsBlock([]) };
      },
    });
    expect(first).toEqual({ enqueued: true });
    // 等 run 进入 running（runner 已被调用 = 状态已翻 running）
    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });
    expect(await readState('seq-role')).toMatchObject({ state: 'running' });

    const second = await enqueueFirstWake('seq-role', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        return { finalOutput: suggestionsBlock([]) };
      },
    });

    releaseRun!();
    await vi.waitFor(async () => { await expect(readState('seq-role')).resolves.toMatchObject({ state: 'completed' }); });
    // 二次入队必须被 exists 挡住，且不安排第二次 run（留时间让潜在的第二跑到达 runner）
    await settle(150);
    expect(harness.runnerCalls).toHaveLength(1);
    expect(second).toEqual({ enqueued: false, reason: 'exists' });
  });

  it('completed / skipped 终态文件永不重入（runner 零调用）', async () => {
    for (const [roleId, state] of [['done-role', 'completed'], ['skip-done-role', 'skipped']] as const) {
      const filePath = statePath(roleId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ state, enqueuedAt: 1, sourcesMode: 'none', suggestions: [] }), 'utf-8');
      const result = await enqueueFirstWake(roleId, {
        runner: async () => { throw new Error('must not run'); },
      });
      expect(result).toEqual({ enqueued: false, reason: 'exists' });
    }
    await settle();
    expect(harness.runnerCalls).toHaveLength(0);
  });

  it('非法 roleId：不抛错、不建文件', async () => {
    const result = await enqueueFirstWake('../escape');
    expect(result).toEqual({ enqueued: false });
    await expect(fs.access(statePath('../escape'))).rejects.toThrow();
  });
});

// ----------------------------------------------------------------------------
// 工具面
// ----------------------------------------------------------------------------

describe('工具面：TOOLSCOPE 白名单 ∩ 只读档', () => {
  it('角色声明空交集（只声明写/执行工具）→ 拒绝全部哨兵', async () => {
    harness.resolveAgent.mockImplementation((roleId: string) => (
      roleId === 'writer-only' ? { id: roleId, tools: ['Write', 'Bash'] } : undefined
    ));
    await enqueueFirstWake('writer-only', {
      runner: async (input) => { harness.runnerCalls.push(input); return { finalOutput: '介绍' }; },
    });
    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });
    expect(harness.runnerCalls[0]!.allowedToolNames).toEqual(DENY_ALL);
  });

  it('角色未声明工具：默认工具表 ∩ 只读（含只读 MCP，不含写/执行/网络）', async () => {
    await enqueueFirstWake('undeclared-role', {
      runner: async (input) => { harness.runnerCalls.push(input); return { finalOutput: '介绍' }; },
    });
    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });
    const allowed = harness.runnerCalls[0]!.allowedToolNames!;
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Grep');
    expect(allowed).toContain('Glob');
    expect(allowed).toContain('mcp__lark__docs.list');
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('Bash');
    expect(allowed).not.toContain('WebSearch');
    expect(allowed).not.toContain('mail_send');
  });
});

// ----------------------------------------------------------------------------
// 提示词变体与 none 硬闸
// ----------------------------------------------------------------------------

describe('提示词变体', () => {
  it('无已连接源：none 变体（引导连接、禁止编造、空建议块）', async () => {
    harness.listCapabilities.mockResolvedValue({ items: [] });
    await enqueueFirstWake('lonely-role', {
      runner: async (input) => { harness.runnerCalls.push(input); return { finalOutput: suggestionsBlock([]) } },
    });
    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });
    const prompt = harness.runnerCalls[0]!.prompt;
    expect(prompt).toContain('没有任何已连接的数据源');
    expect(prompt).toContain('不要编造');
    expect(prompt).toContain('first_wake_suggestions');
    await vi.waitFor(async () => { await expect(readState('lonely-role')).resolves.toMatchObject({ state: 'completed' }); });
    expect(await readState('lonely-role')).toMatchObject({ sourcesMode: 'none', suggestions: [] });
  });

  it('none 模式 host 硬闸：fake runner 给出 3 条建议也不采纳', async () => {
    harness.listCapabilities.mockResolvedValue({ items: [] });
    await enqueueFirstWake('no-invent-role', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        return {
          finalOutput: suggestionsBlock([
            { title: 'a', prompt: 'pa' },
            { title: 'b', prompt: 'pb' },
            { title: 'c', prompt: 'pc' },
          ]),
        };
      },
    });
    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });
    await vi.waitFor(async () => { await expect(readState('no-invent-role')).resolves.toMatchObject({ state: 'completed' }); });
    expect(await readState('no-invent-role')).toMatchObject({ suggestions: [] });
  });

  it('用户期望原话进提示词（两个变体都带）', async () => {
    const { ensureRoleAssetDirs } = await import('../../../../src/host/services/roleAssets/roleAssetService');
    await ensureRoleAssetDirs('expect-role');
    const { writeRolePersonalization } = await import('../../../../src/host/services/roleAssets/rolePersonalization');
    writeRolePersonalization('expect-role', { userExpectation: '帮我盯竞品动态' });
    await enqueueFirstWake('expect-role', {
      runner: async (input) => { harness.runnerCalls.push(input); return { finalOutput: '介绍' }; },
    });
    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });
    expect(harness.runnerCalls[0]!.prompt).toContain('帮我盯竞品动态');
  });
});

// ----------------------------------------------------------------------------
// 解析
// ----------------------------------------------------------------------------

describe('建议解析（经完整 run 落盘观察；解析器私有，行为即契约）', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `t${i}`, prompt: `p${i}` }));

  /** 入队 + connected 模式 + runner 回给定产出，等到 completed 后取落盘的建议 */
  async function parseViaRun(roleId: string, finalOutput: string): Promise<unknown> {
    harness.listCapabilities.mockResolvedValue(connectedInventory());
    await enqueueFirstWake(roleId, {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        return { finalOutput };
      },
    });
    await vi.waitFor(async () => { await expect(readState(roleId)).resolves.toMatchObject({ state: 'completed' }); });
    return (await readState(roleId)).suggestions;
  }

  it('合法块 → 全量解析', async () => {
    expect(await parseViaRun('parse-ok', suggestionsBlock(items(3)))).toEqual(items(3));
  });

  it('5 条 → 截到 3 条', async () => {
    expect(await parseViaRun('parse-cap', suggestionsBlock(items(5)))).toEqual(items(3));
  });

  it('JSON 坏 / 无块 / 非数组 → 空表且状态仍 completed（不重试不重发）', async () => {
    expect(await parseViaRun('parse-bad-json', '```first_wake_suggestions\n{nope\n```')).toEqual([]);
    expect(await parseViaRun('parse-no-block', '没有块的回复')).toEqual([]);
    expect(await parseViaRun('parse-not-array', '```first_wake_suggestions\n{"a":1}\n```')).toEqual([]);
  });

  it('超长字段截断（title 80 / prompt 500）；空字段与重复项丢弃', async () => {
    const longTitle = '长'.repeat(120);
    const suggestions = await parseViaRun('parse-trim', suggestionsBlock([
      { title: longTitle, prompt: 'p'.repeat(600) },
      { title: '  ', prompt: 'p' },
      { title: 'ok', prompt: '' },
      { title: 't', prompt: 't'.repeat(600) },
      { title: 't', prompt: 't'.repeat(600) },
    ]));
    expect(suggestions).toEqual([
      { title: '长'.repeat(80), prompt: 'p'.repeat(500) },
      { title: 't', prompt: 't'.repeat(500) },
    ]);
  });

  it('none 模式：内容再好也丢弃', async () => {
    harness.listCapabilities.mockResolvedValue({ items: [] });
    await enqueueFirstWake('parse-none', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        return { finalOutput: suggestionsBlock(items(3)) };
      },
    });
    await vi.waitFor(async () => { await expect(readState('parse-none')).resolves.toMatchObject({ state: 'completed' }); });
    expect(await readState('parse-none')).toMatchObject({ sourcesMode: 'none', suggestions: [] });
  });
});

// ----------------------------------------------------------------------------
// 跳过
// ----------------------------------------------------------------------------

describe('skipFirstWake', () => {
  it('pending 时跳过：run 在能力查询闸前被拦，runner 从未被调用', async () => {
    let releaseGate: ((value: { items: unknown[] }) => void) | undefined;
    const gate = new Promise<{ items: unknown[] }>((resolve) => { releaseGate = resolve; });
    harness.listCapabilities.mockReturnValueOnce(gate);
    const runner = vi.fn(async () => ({ finalOutput: '介绍' }));
    await enqueueFirstWake('skip-pending', { runner });
    // run 已启动并停在能力查询上（此刻状态仍 pending）
    await vi.waitFor(() => { expect(harness.listCapabilities).toHaveBeenCalled(); });

    expect(await skipFirstWake('skip-pending')).toEqual({ success: true });
    expect(await readState('skip-pending')).toMatchObject({ state: 'skipped', suggestions: [] });

    releaseGate!({ items: [] });
    await settle(80);
    expect(runner).not.toHaveBeenCalled();
    expect(await readState('skip-pending')).toMatchObject({ state: 'skipped' });
  });

  it('running 时跳过：run 完成后状态仍是 skipped，建议不落盘', async () => {
    let releaseRun: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseRun = resolve; });
    await enqueueFirstWake('skip-running', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        await gate;
        return { finalOutput: suggestionsBlock([{ title: 't', prompt: 'p' }]) };
      },
    });
    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });

    expect(await skipFirstWake('skip-running')).toEqual({ success: true });
    expect(await readState('skip-running')).toMatchObject({ state: 'skipped' });

    releaseRun!();
    await vi.waitFor(() => {
      expect(harness.automationRecordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'skipped' }));
    });
    expect(await readState('skip-running')).toMatchObject({ state: 'skipped', suggestions: [] });
  });

  it('completed 后跳过：no-op，状态与建议原样保留', async () => {
    harness.listCapabilities.mockResolvedValue(connectedInventory());
    await enqueueFirstWake('skip-after', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        return { finalOutput: suggestionsBlock([{ title: 't', prompt: 'p' }]) };
      },
    });
    await vi.waitFor(async () => { await expect(readState('skip-after')).resolves.toMatchObject({ state: 'completed' }); });

    expect(await skipFirstWake('skip-after')).toEqual({ success: true });
    expect(await readState('skip-after')).toMatchObject({
      state: 'completed',
      suggestions: [{ title: 't', prompt: 'p' }],
    });
  });

  it('无状态文件：no-op 成功；非法 roleId 拒绝', async () => {
    expect(await skipFirstWake('ghost-role')).toEqual({ success: true });
    expect(await skipFirstWake('../escape')).toEqual({ success: false });
  });
});

// ----------------------------------------------------------------------------
// 失败终态（run 出错不得把状态永久卡在 running/pending）
// ----------------------------------------------------------------------------

describe('失败终态：runner 抛错 / 前置步骤抛错', () => {
  it('runner 抛错：状态落 failed（保留 sessionId、建议清空），自动化记 failed，终态不重入', async () => {
    harness.listCapabilities.mockResolvedValue(connectedInventory());
    await enqueueFirstWake('boom-role', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        throw new Error('model exploded');
      },
    });
    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });

    await vi.waitFor(async () => { await expect(readState('boom-role')).resolves.toMatchObject({ state: 'failed' }); });
    expect(await readState('boom-role')).toMatchObject({
      sessionId: harness.runnerCalls[0]!.sessionId,
      sourcesMode: 'connected',
      suggestions: [],
    });
    expect(harness.automationRecordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed' }));
    // 快照（IPC 读路径）能区分失败与进行中
    expect(await getFirstWakeSnapshot('boom-role')).toMatchObject({ state: 'failed' });
    // failed 是终态：二次入队被 exists 挡住，跳过是 no-op
    expect(await enqueueFirstWake('boom-role', {
      runner: async () => { throw new Error('must not rerun'); },
    })).toEqual({ enqueued: false, reason: 'exists' });
    expect(await skipFirstWake('boom-role')).toEqual({ success: true });
    expect(await readState('boom-role')).toMatchObject({ state: 'failed' });
  });

  it('前置步骤抛错（建会话失败）：pending 也落 failed 终态，runner 从未被调用', async () => {
    mockSessionManager.createSession.mockRejectedValueOnce(new Error('no session'));
    await enqueueFirstWake('early-boom-role', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        return { finalOutput: '介绍' };
      },
    });
    await vi.waitFor(async () => { await expect(readState('early-boom-role')).resolves.toMatchObject({ state: 'failed' }); });
    await settle(50);
    expect(harness.runnerCalls).toHaveLength(0);
    expect(await getFirstWakeSnapshot('early-boom-role')).toMatchObject({ state: 'failed', sourcesMode: 'none' });
    expect(await enqueueFirstWake('early-boom-role', {
      runner: async () => { throw new Error('must not rerun'); },
    })).toEqual({ enqueued: false, reason: 'exists' });
  });

  it('失败不覆盖用户跳过：running 中跳过后 runner 抛错 → 状态保持 skipped、建议不落盘', async () => {
    let releaseRun: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseRun = resolve; });
    await enqueueFirstWake('skip-fail-role', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        await gate;
        throw new Error('late failure');
      },
    });
    await vi.waitFor(() => { expect(harness.runnerCalls).toHaveLength(1); });

    expect(await skipFirstWake('skip-fail-role')).toEqual({ success: true });
    releaseRun!();
    await vi.waitFor(() => {
      expect(harness.automationRecordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed' }));
    });
    expect(await readState('skip-fail-role')).toMatchObject({ state: 'skipped', suggestions: [] });
  });
});

// ----------------------------------------------------------------------------
// 快照（IPC 读路径的数据源）
// ----------------------------------------------------------------------------

describe('getFirstWakeSnapshot', () => {
  it('无文件 → null；有状态 → 透传形状', async () => {
    harness.listCapabilities.mockResolvedValue(connectedInventory());
    expect(await getFirstWakeSnapshot('ghost-role')).toBeNull();

    await enqueueFirstWake('snap-role', {
      runner: async (input) => {
        harness.runnerCalls.push(input);
        return { finalOutput: suggestionsBlock([{ title: 't', prompt: 'p' }]) };
      },
    });
    await vi.waitFor(async () => { await expect(readState('snap-role')).resolves.toMatchObject({ state: 'completed' }); });
    expect(await getFirstWakeSnapshot('snap-role')).toEqual({
      state: 'completed',
      sessionId: harness.runnerCalls[0]!.sessionId,
      sourcesMode: 'connected',
      suggestions: [{ title: 't', prompt: 'p' }],
    });
  });

  it('非法 roleId → null', async () => {
    expect(await getFirstWakeSnapshot('../escape')).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// 默认执行器（无注入 runner 时）：orchestrator / headless 两条分支
// ----------------------------------------------------------------------------

describe('默认执行器', () => {
  it('orchestrator 分支：allowedToolNames 进 sendMessage 选项，产出从会话尾读', async () => {
    harness.listCapabilities.mockResolvedValue(connectedInventory());
    harness.resolveAgent.mockImplementation((roleId: string) => (
      roleId === 'orch-role' ? { id: roleId, tools: ['Read'] } : undefined
    ));
    const finalOutput = suggestionsBlock([{ title: 't', prompt: 'p' }]);
    mockSessionManager.getSession.mockImplementation(async (id: string) => ({
      id,
      messages: [
        { id: 'm1', role: 'user', content: 'prompt' },
        { id: 'm2', role: 'assistant', content: '旧回复' },
        { id: 'm3', role: 'assistant', content: finalOutput },
      ],
    }));
    harness.sendMessage.mockResolvedValue(undefined);

    await enqueueFirstWake('orch-role');
    await vi.waitFor(() => { expect(harness.sendMessage).toHaveBeenCalledTimes(1); });

    const options = harness.sendMessage.mock.calls[0]![2] as {
      allowedToolNames?: string[];
      agentOverrideId?: string;
      inputSource?: string;
      maxIterations?: number;
    };
    expect(options.allowedToolNames).toEqual(['Read']);
    expect(options.agentOverrideId).toBe('orch-role');
    expect(options.inputSource).toBe('automation');
    expect(typeof options.maxIterations).toBe('number');

    await vi.waitFor(async () => { await expect(readState('orch-role')).resolves.toMatchObject({ state: 'completed' }); });
    expect(await readState('orch-role')).toMatchObject({ suggestions: [{ title: 't', prompt: 'p' }] });
  });

  it('headless 分支：allowedToolNames 进 CLI loop config', async () => {
    harness.orchestratorPresent = false;
    harness.resolveAgent.mockImplementation((roleId: string) => (
      roleId === 'cli-role' ? { id: roleId, tools: ['Read', 'Write'] } : undefined
    ));
    mockSessionManager.getSession.mockImplementation(async (id: string) => ({
      id,
      messages: [{ id: 'm1', role: 'assistant', content: 'headless 介绍' }],
    }));

    await enqueueFirstWake('cli-role');
    await vi.waitFor(() => { expect(harness.loops).toHaveLength(1); });
    expect(harness.loops[0]!.allowedToolNames).toEqual(['Read']);

    await vi.waitFor(async () => { await expect(readState('cli-role')).resolves.toMatchObject({ state: 'completed' }); });
  });
});
