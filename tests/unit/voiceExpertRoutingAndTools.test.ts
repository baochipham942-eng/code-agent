// A3 专家继承 + A4 窄工具的接线门。
//
// 钉的是「消费者真的读到了」，不是「函数返回了对的字符串」：
//   · spawn_task 派出去的那一轮，agentOverrideId 必须是通话身份；
//   · 那一轮必须过 withWorkbenchTurnSystemContext（连接器收窄的唯一发生地——
//     host 直调 orchestrator.sendMessage 一律绕开它，这是 #637 同款形状），
//     所以断言专家声明的 connectors 真的进了 toolScope.allowedConnectorIds；
//   · 执行 run 拿全量角色资料，通话 brain 只拿短人设（§6.7.3 的隐私/体量边界）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRunOptions } from '../../src/host/research/types';

const sendMessage = vi.hoisted(() => vi.fn(async (_content: string, _attachments: undefined, _options: AgentRunOptions) => undefined));
const buildRoleContextBlock = vi.hoisted(() => vi.fn(async () => '<role>全量 L0/L1 资料架</role>'));
const incompleteTasks = vi.hoisted(() => ({ value: [] as Array<{ subject: string; status: string }> }));
const resolvedAgent = vi.hoisted(() => ({
  value: undefined as undefined | { id: string; name: string; description?: string; connectors?: Array<{ id: string; level: string }> },
}));

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({ getOrCreateCurrentOrchestrator: () => ({ sendMessage }) }),
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({ buildRoleContextBlock }));
vi.mock('../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => incompleteTasks.value,
}));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async () => ({
      messages: [{ toolCalls: [{ arguments: { file_path: '/repo/src/a.ts' } }, { arguments: { file_path: '/repo/src/b.ts' } }] }],
    }),
  }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// 连接器就绪判定与 registry：让「专家声明了 crm，且它已连上」成为可控事实。
vi.mock('../../src/host/agent/agentRegistry', () => ({
  resolveAgent: () => resolvedAgent.value,
}));
vi.mock('../../src/host/connectors', () => ({
  // 没有 cachedStatus 的连接器按「已就绪」算（见 isConnectorReadyForTurnScope）
  getConnectorRegistry: () => ({ get: (id: string) => (id === 'crm' ? { id } : undefined) }),
}));

const { executeVoiceTool, VOICE_TOOL_DEFINITIONS } = await import('../../src/host/services/voice/voiceTools');
const { resolveVoiceRouting } = await import('../../src/host/services/voice/voiceRouting');

const workItems = vi.hoisted(() => ({ value: [] as Array<{ status: string; title: string; detail?: string }> }));

function toolContext(activeAgentId?: string) {
  return {
    neoSessionId: 'session-1',
    activeAgentId,
    onWorkItem: (item: { status: string; title: string; detail?: string }) => workItems.value.push(item),
  };
}

function lastRunOptions(): AgentRunOptions {
  const call = sendMessage.mock.calls.at(-1);
  if (!call) throw new Error('sendMessage was never called');
  return call[2];
}

describe('A3 通话身份解析', () => {
  beforeEach(() => {
    resolvedAgent.value = undefined;
  });

  it('没选专家时不编人设，只给通话基线', () => {
    const routing = resolveVoiceRouting(undefined);
    expect(routing.activeAgentId).toBeUndefined();
    expect(routing.personaInstructions).toContain('spawn_task');
    expect(routing.personaInstructions).not.toContain('身份是');
  });

  it('选了专家时短人设进 instructions，且不带全量角色资料', () => {
    resolvedAgent.value = { id: 'muzhi', name: '牧之', description: '内容主理人' };

    const routing = resolveVoiceRouting('muzhi');

    expect(routing.activeAgentId).toBe('muzhi');
    expect(routing.personaInstructions).toContain('牧之');
    expect(routing.personaInstructions).toContain('不要自称团队里的其他成员');
    // 通话 brain 拿到的必须是短人设——全量 L0/L1 只进执行 run（§6.7.3）
    expect(buildRoleContextBlock).not.toHaveBeenCalled();
    expect(routing.personaInstructions.length).toBeLessThan(500);
  });
});

describe('A4 窄工具', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    buildRoleContextBlock.mockClear();
    resolvedAgent.value = undefined;
    incompleteTasks.value = [];
    workItems.value = [];
  });

  it('只注册三个工具，且没有一个能直接改东西', () => {
    expect(VOICE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'get_active_tasks',
      'get_current_file_summary',
      'spawn_task',
    ]);
  });

  it('get_active_tasks 报真实任务，空的时候明说没有', async () => {
    expect(await executeVoiceTool('get_active_tasks', '{}', toolContext())).toContain('没有进行中的任务');

    incompleteTasks.value = [{ subject: '跑测试', status: 'in_progress' }];
    expect(await executeVoiceTool('get_active_tasks', '{}', toolContext())).toContain('跑测试');
  });

  it('get_current_file_summary 取会话里真发生过的文件动作', async () => {
    const result = await executeVoiceTool('get_current_file_summary', '{}', toolContext());
    expect(result).toContain('/repo/src/a.ts');
    expect(result).toContain('/repo/src/b.ts');
  });

  it('spawn_task 派出的一轮带通话身份，并注入全量角色资料', async () => {
    resolvedAgent.value = { id: 'muzhi', name: '牧之' };

    const result = await executeVoiceTool('spawn_task', JSON.stringify({ title: '改大纲', prompt: '把大纲改成三段' }), toolContext('muzhi'));

    // 措辞不能让通话 brain 转述成「已经做完了」——真机实测过一次这种撒谎
    expect(result).toContain('排上队');
    expect(result).not.toContain('完成了');
    expect(workItems.value).toEqual([expect.objectContaining({ title: '改大纲', status: 'queued' })]);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls.at(-1)?.[0]).toBe('把大纲改成三段');
    const options = lastRunOptions();
    expect(options.agentOverrideId).toBe('muzhi');
    expect(options.turnSystemContext?.[0]).toContain('全量 L0/L1');
    expect(buildRoleContextBlock).toHaveBeenCalledWith('muzhi');
  });

  it('spawn_task 那一轮真过了连接器收窄（专家声明的 connectors 进 toolScope）', async () => {
    // core 档的声明才参与收窄（optional 不自动进 scope）
    resolvedAgent.value = { id: 'muzhi', name: '牧之', connectors: [{ id: 'crm', level: 'core' }] };

    await executeVoiceTool('spawn_task', JSON.stringify({ title: 'a', prompt: '去 crm 查一下' }), toolContext('muzhi'));

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(lastRunOptions().toolScope?.allowedConnectorIds).toContain('crm');
  });

  // D4 的另一半：管理器支持 run 级持票没用，得 spawnTask 真的去取那张票。
  // 2026-07-26 真机的洞就在这——挂断即解除，语音派的 run 后半程直接按会话档落盘。
  // 判据是「run 在飞时抬严标记为真、落地后为假」，不是「有没有调某个函数」。
  it('spawn_task 为这一轮单独持票，run 落地才还（抬严罩住整个 run）', async () => {
    const { getPermissionModeManager } = await import('../../src/host/permissions/modes');
    const permissions = getPermissionModeManager();
    let settle!: () => void;
    sendMessage.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      settle = () => resolve(undefined);
    }));

    expect(permissions.isLiveVoiceSession('session-1')).toBe(false);

    await executeVoiceTool('spawn_task', JSON.stringify({ title: 'a', prompt: '干活' }), toolContext());

    // 注意这里没有任何「通话票」——只有 run 票。挂断早于 run 结束时就是这个状态。
    expect(permissions.isLiveVoiceSession('session-1')).toBe(true);

    settle();
    await vi.waitFor(() => expect(permissions.isLiveVoiceSession('session-1')).toBe(false));
  });

  it('run 失败也要还票（否则会话永久卡在只读档）', async () => {
    const { getPermissionModeManager } = await import('../../src/host/permissions/modes');
    const permissions = getPermissionModeManager();
    sendMessage.mockImplementationOnce(async () => { throw new Error('boom'); });

    await executeVoiceTool('spawn_task', JSON.stringify({ title: 'a', prompt: '干活' }), toolContext());

    await vi.waitFor(() => expect(permissions.isLiveVoiceSession('session-1')).toBe(false));
    expect(workItems.value.at(-1)).toEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('缺少任务内容时不派活（口误不该变成一次真跑）', async () => {
    const result = await executeVoiceTool('spawn_task', JSON.stringify({ title: '空的' }), toolContext());
    expect(result).toContain('没有派发');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('派发失败会回流 work.upsert failed（不能只在日志里烂掉）', async () => {
    resolvedAgent.value = { id: 'muzhi', name: '牧之' };
    sendMessage.mockRejectedValueOnce(new Error('trust identity changed'));

    await executeVoiceTool('spawn_task', JSON.stringify({ title: '写文件', prompt: '建个文件' }), toolContext('muzhi'));

    await vi.waitFor(() => expect(workItems.value.some((item) => item.status === 'failed')).toBe(true));
    expect(workItems.value.at(-1)).toMatchObject({ title: '写文件', status: 'failed', detail: 'trust identity changed' });
  });
});
