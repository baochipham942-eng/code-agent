// A3 专家继承 + A4 窄工具 + H1/H2 指挥台（Intent → Coordinator）的接线门。
//
// 钉的是「消费者真的读到了」，不是「函数返回了对的字符串」：
//   · spawn_task 派出去的那一轮，agentOverrideId 必须是通话身份；
//   · 那一轮必须过 withWorkbenchTurnSystemContext（连接器收窄的唯一发生地——
//     host 直调 orchestrator.sendMessage 一律绕开它，这是 #637 同款形状），
//     所以断言专家声明的 connectors 真的进了 toolScope.allowedConnectorIds；
//   · 执行 run 拿全量角色资料，通话 brain 只拿短人设（§6.7.3 的隐私/体量边界）。
//
// 批 H 起，派活走 TaskManager.startTask 而不是 orchestrator.sendMessage——
// 后者绕开状态机，会让 cancelTask 看到 idle 直接返回（叫停无效）、
// interruptAndContinue fallthrough 成再派一件新活（改方向变成开新活）。
// 所以这里的假 TaskManager 必须模状态机 + 生命周期事件，不能只留一个 sendMessage。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentRunOptions } from '../../src/host/research/types';

type FakeEvent = { type: string; sessionId: string; data?: unknown };

const runtime = vi.hoisted(() => ({
  listeners: new Set<(event: FakeEvent) => void>(),
  status: 'idle' as string,
  startTask: vi.fn(async (
    _sessionId: string,
    _message: string,
    _attachments: unknown,
    _options: AgentRunOptions,
  ) => undefined),
  interruptAndContinue: vi.fn(async (_sessionId: string, _message: string) => ({ outcome: 'steered' as const })),
  cancelTask: vi.fn(async (_sessionId: string) => undefined),
  emit(type: string, sessionId = 'session-1', data?: unknown) {
    for (const listener of [...this.listeners]) listener({ type, sessionId, data });
  },
}));

const buildRoleContextBlock = vi.hoisted(() => vi.fn(async () => '<role>全量 L0/L1 资料架</role>'));
const voiceSettings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const incompleteTasks = vi.hoisted(() => ({ value: [] as Array<{ subject: string; status: string }> }));
const resolvedAgent = vi.hoisted(() => ({
  value: undefined as undefined | { id: string; name: string; description?: string; connectors?: Array<{ id: string; level: string }> },
}));

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.add(listener); },
    off: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.delete(listener); },
    getSessionState: () => ({ status: runtime.status }),
    startTask: runtime.startTask,
    interruptAndContinue: runtime.interruptAndContinue,
    cancelTask: runtime.cancelTask,
  }),
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({ buildRoleContextBlock }));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ voice: { live: voiceSettings.value } }) }),
}));
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
const { beginVoiceDispatch, endVoiceDispatch } = await import('../../src/host/services/voice/voiceAgentCoordinator');
const { resolveVoiceRouting } = await import('../../src/host/services/voice/voiceRouting');

const workItems = vi.hoisted(() => ({ value: [] as Array<{ id: string; status: string; title: string; detail?: string }> }));

function bind(activeAgentId?: string): void {
  beginVoiceDispatch({
    neoSessionId: 'session-1',
    activeAgentId,
    onWorkItem: (item) => workItems.value.push({ ...item }),
  });
}

function lastRunOptions(): AgentRunOptions {
  const call = runtime.startTask.mock.calls.at(-1);
  if (!call) throw new Error('startTask was never called');
  return call[3];
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

describe('A4 窄工具 / H1 指挥台', () => {
  beforeEach(() => {
    runtime.startTask.mockClear();
    runtime.startTask.mockImplementation(async () => undefined);
    runtime.interruptAndContinue.mockClear();
    runtime.cancelTask.mockClear();
    runtime.status = 'idle';
    buildRoleContextBlock.mockClear();
    resolvedAgent.value = undefined;
    incompleteTasks.value = [];
    workItems.value = [];
    voiceSettings.value = {};
  });

  afterEach(() => {
    // 把还没落地的 work item 结掉，否则它的 D4 run 票会漏到下一个用例里。
    runtime.emit('task_cancelled');
    endVoiceDispatch();
  });

  it('注册五个工具：两只读 + 派活/改方向/叫停，没有一个能直接改东西', () => {
    expect(VOICE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'get_active_tasks',
      'get_current_file_summary',
      'spawn_task',
      'steer_task',
      'cancel_task',
    ]);
  });

  it('get_active_tasks 报真实任务，空的时候明说没有', async () => {
    bind();
    expect(await executeVoiceTool('get_active_tasks', '{}')).toContain('没有进行中的任务');

    incompleteTasks.value = [{ subject: '跑测试', status: 'in_progress' }];
    expect(await executeVoiceTool('get_active_tasks', '{}')).toContain('跑测试');
  });

  it('get_current_file_summary 取会话里真发生过的文件动作', async () => {
    bind();
    const result = await executeVoiceTool('get_current_file_summary', '{}');
    expect(result).toContain('/repo/src/a.ts');
    expect(result).toContain('/repo/src/b.ts');
  });

  it('spawn_task 派出的一轮带通话身份，并注入全量角色资料', async () => {
    resolvedAgent.value = { id: 'muzhi', name: '牧之' };
    bind('muzhi');

    const result = await executeVoiceTool('spawn_task', JSON.stringify({ title: '改大纲', prompt: '把大纲改成三段' }));

    // 措辞不能让通话 brain 转述成「已经做完了」——真机实测过一次这种撒谎
    expect(result).toContain('排上队');
    expect(result).not.toContain('完成了');
    expect(workItems.value).toEqual([expect.objectContaining({ title: '改大纲', status: 'queued' })]);
    await vi.waitFor(() => expect(runtime.startTask).toHaveBeenCalled());
    expect(runtime.startTask.mock.calls.at(-1)?.[1]).toBe('把大纲改成三段');
    const options = lastRunOptions();
    expect(options.agentOverrideId).toBe('muzhi');
    expect(options.turnSystemContext?.[0]).toContain('全量 L0/L1');
    expect(buildRoleContextBlock).toHaveBeenCalledWith('muzhi');
  });

  it('spawn_task 那一轮真过了连接器收窄（专家声明的 connectors 进 toolScope）', async () => {
    // core 档的声明才参与收窄（optional 不自动进 scope）
    resolvedAgent.value = { id: 'muzhi', name: '牧之', connectors: [{ id: 'crm', level: 'core' }] };
    bind('muzhi');

    await executeVoiceTool('spawn_task', JSON.stringify({ title: 'a', prompt: '去 crm 查一下' }));

    await vi.waitFor(() => expect(runtime.startTask).toHaveBeenCalled());
    expect(lastRunOptions().toolScope?.allowedConnectorIds).toContain('crm');
  });

  // H4 双脑分离（§6.1）：配了语音执行引擎就得真落到那一轮 run 的 modelSpec 上。
  // 判据是「消费者读到了」而不是「设置存下了」——存下但没人读正是本仓的常见死法。
  it('配了语音执行引擎时那一轮带上 modelSpec', async () => {
    voiceSettings.value = { executionModel: { provider: 'deepseek', model: 'deepseek-chat' } };
    bind();

    await executeVoiceTool('spawn_task', JSON.stringify({ title: 'a', prompt: '干活' }));

    await vi.waitFor(() => expect(runtime.startTask).toHaveBeenCalled());
    expect(lastRunOptions().modelSpec).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('没配就不传 modelSpec（跟随会话默认引擎，行为与批 H 之前一致）', async () => {
    bind();

    await executeVoiceTool('spawn_task', JSON.stringify({ title: 'a', prompt: '干活' }));

    await vi.waitFor(() => expect(runtime.startTask).toHaveBeenCalled());
    expect(lastRunOptions().modelSpec).toBeUndefined();
  });

  // H2：批 A 只有 queued / failed 两态——run 干完了不发任何事件，条目永远停在「排队中」。
  it('work item 走完 queued → running → done（run 干完了得有人说一声）', async () => {
    bind();

    await executeVoiceTool('spawn_task', JSON.stringify({ title: '跑测试', prompt: '跑一下测试' }));
    expect(workItems.value.at(-1)).toMatchObject({ status: 'queued' });

    runtime.emit('task_started');
    expect(workItems.value.at(-1)).toMatchObject({ status: 'running' });

    runtime.emit('task_completed');
    expect(workItems.value.at(-1)).toMatchObject({ title: '跑测试', status: 'done' });
  });

  it('steer_task 在有活跑时打断续跑，不再派一件新的', async () => {
    bind();
    await executeVoiceTool('spawn_task', JSON.stringify({ title: '改大纲', prompt: '改成三段' }));
    runtime.startTask.mockClear();
    runtime.status = 'running';

    const result = await executeVoiceTool('steer_task', JSON.stringify({ instruction: '改成五段' }));

    expect(runtime.interruptAndContinue).toHaveBeenCalledTimes(1);
    expect(runtime.interruptAndContinue.mock.calls.at(-1)?.[1]).toBe('改成五段');
    // 关键：不能顺手又 startTask 一件新的（那正是绕开状态机时的旧行为）
    expect(runtime.startTask).not.toHaveBeenCalled();
    expect(result).toContain('打断');
    expect(result).not.toContain('做完了');
  });

  it('steer_task 在没活跑时如实说「当成新任务派了」，不假装 steer 成功', async () => {
    bind();
    runtime.status = 'idle';

    const result = await executeVoiceTool('steer_task', JSON.stringify({ instruction: '把首页改成深色' }));

    expect(runtime.interruptAndContinue).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.startTask).toHaveBeenCalled());
    expect(result).toContain('新任务');
  });

  it('cancel_task 真调到 TaskManager，并把条目落成 cancelled', async () => {
    bind();
    await executeVoiceTool('spawn_task', JSON.stringify({ title: '删文件', prompt: '删掉临时文件' }));
    runtime.status = 'running';

    const result = await executeVoiceTool('cancel_task', '{}');
    expect(runtime.cancelTask).toHaveBeenCalledWith('session-1');
    expect(result).toContain('停下来');

    runtime.emit('task_cancelled');
    expect(workItems.value.at(-1)).toMatchObject({ title: '删文件', status: 'cancelled' });
  });

  it('已有活在跑时不再派新的，而是告诉用户两条出路', async () => {
    bind();
    runtime.status = 'running';

    const result = await executeVoiceTool('spawn_task', JSON.stringify({ title: 'b', prompt: '再干一件' }));

    expect(runtime.startTask).not.toHaveBeenCalled();
    expect(result).toContain('改方向');
    expect(result).toContain('别做了');
  });

  it('没活跑时叫停不说谎（不谎报已经停了）', async () => {
    bind();
    runtime.status = 'idle';

    expect(await executeVoiceTool('cancel_task', '{}')).toContain('没有在跑的活');
    expect(runtime.cancelTask).not.toHaveBeenCalled();
  });

  // D4 的另一半：管理器支持 run 级持票没用，得派活时真的去取那张票。
  // 2026-07-26 真机的洞就在这——挂断即解除，语音派的 run 后半程直接按会话档落盘。
  // 判据是「run 在飞时抬严标记为真、落地后为假」，不是「有没有调某个函数」。
  it('spawn_task 为这一轮单独持票，run 落地才还（抬严罩住整个 run）', async () => {
    const { getPermissionModeManager } = await import('../../src/host/permissions/modes');
    const permissions = getPermissionModeManager();
    bind();

    expect(permissions.isLiveVoiceSession('session-1')).toBe(false);

    await executeVoiceTool('spawn_task', JSON.stringify({ title: 'a', prompt: '干活' }));

    // 注意这里没有任何「通话票」——只有 run 票。挂断早于 run 结束时就是这个状态。
    expect(permissions.isLiveVoiceSession('session-1')).toBe(true);

    runtime.emit('task_completed');
    expect(permissions.isLiveVoiceSession('session-1')).toBe(false);
  });

  it('挂断不还 run 的票，run 落地才还（D4 覆盖整个 run 生命周期）', async () => {
    const { getPermissionModeManager } = await import('../../src/host/permissions/modes');
    const permissions = getPermissionModeManager();
    bind();

    await executeVoiceTool('spawn_task', JSON.stringify({ title: 'a', prompt: '干活' }));
    endVoiceDispatch(); // 用户说完就挂——这是常态

    expect(permissions.isLiveVoiceSession('session-1')).toBe(true);

    runtime.emit('task_completed');
    expect(permissions.isLiveVoiceSession('session-1')).toBe(false);
  });

  it('run 启动失败也要还票（否则会话永久卡在只读档）', async () => {
    const { getPermissionModeManager } = await import('../../src/host/permissions/modes');
    const permissions = getPermissionModeManager();
    runtime.startTask.mockImplementationOnce(async () => { throw new Error('boom'); });
    bind();

    await executeVoiceTool('spawn_task', JSON.stringify({ title: 'a', prompt: '干活' }));

    await vi.waitFor(() => expect(permissions.isLiveVoiceSession('session-1')).toBe(false));
    expect(workItems.value.at(-1)).toEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('缺少任务内容时不派活（口误不该变成一次真跑）', async () => {
    bind();
    const result = await executeVoiceTool('spawn_task', JSON.stringify({ title: '空的' }));
    expect(result).toContain('没有派发');
    expect(runtime.startTask).not.toHaveBeenCalled();
  });

  it('派发失败会回流 work.upsert failed（不能只在日志里烂掉）', async () => {
    resolvedAgent.value = { id: 'muzhi', name: '牧之' };
    runtime.startTask.mockImplementationOnce(async () => { throw new Error('trust identity changed'); });
    bind('muzhi');

    await executeVoiceTool('spawn_task', JSON.stringify({ title: '写文件', prompt: '建个文件' }));

    await vi.waitFor(() => expect(workItems.value.some((item) => item.status === 'failed')).toBe(true));
    expect(workItems.value.at(-1)).toMatchObject({ title: '写文件', status: 'failed', detail: 'trust identity changed' });
  });
});
