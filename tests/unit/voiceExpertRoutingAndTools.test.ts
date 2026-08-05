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
import { TEAM_LEAD_METADATA_KEY } from '../../src/shared/contract/teamRecipe';

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
type FakeAgent = { id: string; name: string; description?: string; source?: string; connectors?: Array<{ id: string; level: string }> };
// value = 「不管问哪个 id 都回它」的老口径；byId 是语音批 B 加的按 id 分辨口径——
// 「显式点名压过 lead 默认」要求同一次调用里两个 id 解析成不同的人，一个共享值做不到。
// byId 不设时行为与老口径完全一致（下面每个 describe 的 beforeEach 都清掉它）。
const resolvedAgent = vi.hoisted(() => ({
  value: undefined as undefined | FakeAgent,
  byId: undefined as undefined | Record<string, FakeAgent>,
}));

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.add(listener); },
    off: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.delete(listener); },
    // §2 进度旁路：真 TaskManager 有这个方法，替身不给就会让 ensureListener 走降级分支，
    // 测到的就不是产品真实路径。
    observeAgentEvents: () => () => {},
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
// 本文件钉的是路由/窄工具/D4 持票，不是完成语义证据门：给一份「确实改了文件」的 run
// 记录，让 task_completed 照旧落 done。证据门本身由 voiceWorkEvidenceGate.test.ts 钉。
vi.mock('../../src/host/session/completionSummaryService', () => ({
  readLatestCompletionSummaryRecord: async () => ({
    changedFiles: ['/repo/src/a.ts'],
    artifactRefs: [],
    commitIds: [],
    verificationEvidence: [],
    endedAt: Number.MAX_SAFE_INTEGER,
  }),
}));
// 连接器就绪判定与 registry：让「专家声明了 crm，且它已连上」成为可控事实。
vi.mock('../../src/host/agent/agentRegistry', () => ({
  resolveAgent: (agentId: string) => resolvedAgent.byId?.[agentId] ?? resolvedAgent.value,
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
    voiceSessionId: 'voice-1',
    activeAgentId,
    onWorkItem: (item) => workItems.value.push({ ...item }),
    // 失败出口的行为由 voiceWorkFailureVisible.test.ts 专门钉；这里只是补齐契约。
    onWorkFailed: () => {},
    onEndCall: () => {},
    onWorkNarration: () => {},
  });
}

function lastRunOptions(): AgentRunOptions {
  const call = runtime.startTask.mock.calls.at(-1);
  if (!call) throw new Error('startTask was never called');
  return call[3];
}

/**
 * `task_completed` 到终态之间隔着一次证据查询（X5.5-A2-a），是异步的。
 * 「跑完了」不再等于「做成了」，所以终态断言必须等这一步落地。
 */
async function settleFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('A3 通话身份解析', () => {
  beforeEach(() => {
    resolvedAgent.value = undefined;
    resolvedAgent.byId = undefined;
  });

  it('没选专家时不编人设，只给通话基线', () => {
    const routing = resolveVoiceRouting(undefined);
    expect(routing.activeAgentId).toBeUndefined();
    expect(routing.personaInstructions).toContain('spawn_task');
    expect(routing.personaInstructions).not.toContain('身份是');
  });

  it('系统型内置 agent（面板选不到的）不当专家：不署名、不套人设（批 X §5，真机署名 Dream）', () => {
    // dream 是 PANEL_HIDDEN_BUILTIN_AGENT_IDS 里的系统型内置——用户没有任何途径点名它。
    // 它出现在 requestedAgentId 里只可能是存量脏映射，语音层必须按「没选专家」处理。
    resolvedAgent.value = { id: 'dream', name: 'Dream', source: 'builtin' };

    const routing = resolveVoiceRouting('dream');

    expect(routing.activeAgentId).toBeUndefined();
    expect(routing.personaInstructions).toBe(resolveVoiceRouting(undefined).personaInstructions);
  });

  it('选了专家时短人设进 instructions，且不带全量角色资料', () => {
    resolvedAgent.value = { id: 'muzhi', name: '牧之', description: '内容主理人' };

    const routing = resolveVoiceRouting('muzhi');

    expect(routing.activeAgentId).toBe('muzhi');
    expect(routing.personaInstructions).toContain('牧之');
    expect(routing.personaInstructions).toContain('不要自称团队里的其他成员');
    // 通话 brain 拿到的必须是短人设——全量 L0/L1 只进执行 run（§6.7.3）
    expect(buildRoleContextBlock).not.toHaveBeenCalled();
    expect(routing.personaInstructions).not.toContain('资料架');
    // 判据钉在「人设那一段是短的」，不钉整份 instructions 的总长：基线指令会随行为约束
    // 迭代增删（2026-07-28 分诊立场改写就把它推过了 500），拿总长当判据会把正常的
    // prompt 迭代误报成隐私回归。
    const personaOnly = routing.personaInstructions.replace(resolveVoiceRouting(undefined).personaInstructions, '');
    expect(personaOnly.length).toBeLessThan(200);
  });
});

// 语音批 B：团会话里用户不点名直接打过来，接电话的应该是主理人，而不是无名的通话基线。
// 真源与成员条 isLead 同一个（readPersistedTeamLead 读 sessions.metadata.teamLead），
// 所以这里钉的是「读到了、按优先级用了、读不出时不乱认人」这三条。
describe('语音批 B 团会话默认收件人 = Lead', () => {
  beforeEach(() => {
    resolvedAgent.value = undefined;
    resolvedAgent.byId = undefined;
  });

  const teamSessionMetadata = (roleId: string): Record<string, unknown> => ({
    [TEAM_LEAD_METADATA_KEY]: { roleId, recipeId: 'recipe-1', setAt: 1 },
  });

  it('没点名时默认收件人 = 会话 lead，署名与短人设都按 lead 走', () => {
    resolvedAgent.byId = { yanzhi: { id: 'yanzhi', name: '衍之', description: '策略主理人' } };

    const routing = resolveVoiceRouting(undefined, teamSessionMetadata('yanzhi'));

    // activeAgentId 就是下游署名/字幕/派活锁身份读的那个值（beginVoiceDispatch → resolveNarrationSpeaker）
    expect(routing.activeAgentId).toBe('yanzhi');
    expect(routing.personaInstructions).toContain('衍之');
    expect(routing.personaInstructions).toContain('不要自称团队里的其他成员');
  });

  it('显式点名压过 lead 默认（优先级：显式 > teamLead > 基线）', () => {
    resolvedAgent.byId = {
      yanzhi: { id: 'yanzhi', name: '衍之', description: '策略主理人' },
      muzhi: { id: 'muzhi', name: '牧之', description: '内容主理人' },
    };

    const routing = resolveVoiceRouting('muzhi', teamSessionMetadata('yanzhi'));

    expect(routing.activeAgentId).toBe('muzhi');
    expect(routing.personaInstructions).not.toContain('衍之');
  });

  it('fail-closed：lead 解析不出真身时回落无专家基线，不替用户认人', () => {
    // byId 不含它、value 也是 undefined ⇒ resolveAgent 查无此人，且它不是内置货架角色。
    // 显式点名的 id 查不到会照传（用户自己选的），默认收件人不行——没人点过名，认错就是
    // 让一位用户没选的专家接了电话。
    const routing = resolveVoiceRouting(undefined, teamSessionMetadata('ghost-lead-not-registered'));

    expect(routing.activeAgentId).toBeUndefined();
    expect(routing.personaInstructions).toBe(resolveVoiceRouting(undefined).personaInstructions);
  });

  it('fail-closed：lead 是面板选不到的系统型内置时回落无专家基线', () => {
    resolvedAgent.byId = { dream: { id: 'dream', name: 'Dream', source: 'builtin' } };

    const routing = resolveVoiceRouting(undefined, teamSessionMetadata('dream'));

    expect(routing.activeAgentId).toBeUndefined();
    expect(routing.personaInstructions).toBe(resolveVoiceRouting(undefined).personaInstructions);
  });

  it('fail-closed：非团会话 / teamLead 标记残缺时都不认', () => {
    resolvedAgent.byId = { yanzhi: { id: 'yanzhi', name: '衍之' } };

    // 单人会话：没有 teamLead 这个 key，以及 host 完全取不到 metadata（无 DB）的情形
    expect(resolveVoiceRouting(undefined, {}).activeAgentId).toBeUndefined();
    expect(resolveVoiceRouting(undefined, undefined).activeAgentId).toBeUndefined();
    // 标记残缺（缺 recipeId/setAt）：readPersistedTeamLead 判不合法，不能当半个 lead 用
    expect(resolveVoiceRouting(undefined, { [TEAM_LEAD_METADATA_KEY]: { roleId: 'yanzhi' } }).activeAgentId).toBeUndefined();
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
    resolvedAgent.byId = undefined;
    incompleteTasks.value = [];
    workItems.value = [];
    voiceSettings.value = {};
  });

  afterEach(() => {
    // 把还没落地的 work item 结掉，否则它的 D4 run 票会漏到下一个用例里。
    runtime.emit('task_cancelled');
    endVoiceDispatch();
  });

  it('注册面：只读查询 + 看屏 + 派活/改方向/叫停 + 收线，没有一个能直接改东西', () => {
    // 2026-07-28 真机加了两只：`get_current_time`（此前它只会说「我看不到时间」）、
    // `end_call`（此前它说「已挂断」但通话还开着，是第二例「说了没做」）。
    // Phase 3 加了 `capture_screen_context`：它采屏但不落用户文件，零写权限的底线没破。
    expect(VOICE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'get_active_tasks',
      'get_current_file_summary',
      'capture_screen_context',
      'spawn_task',
      'steer_task',
      'cancel_task',
      'get_current_time',
      'end_call',
    ]);
    // D5：通话 brain 全程零写权限——注册面里不许出现能直接落盘/跑命令的参数。
    const params = JSON.stringify(VOICE_TOOL_DEFINITIONS.map((tool) => tool.parameters));
    expect(params).not.toContain('file_path');
    expect(params).not.toContain('command');
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

    // ①（批 X）：返回值是言语行为指令 + 认知协议，不是状态描述——「已排队」这种
    // 状态名词会被通话 brain 润色成「已完成」（真机撞过三次）。钉三件事：
    // 有下一句台词、结果只认 [BACKEND] 回流、进度问题落 get_active_tasks；
    // 且不给任何可润色的状态名词。
    expect(result).toContain('现在对用户说');
    expect(result).toContain('[BACKEND]');
    expect(result).toContain('get_active_tasks');
    expect(result).not.toMatch(/排队|后台|完成了/);
    expect(workItems.value.at(-2)).toEqual(expect.objectContaining({ title: '改大纲', status: 'queued' }));
    expect(workItems.value.at(-1)).toEqual(expect.objectContaining({ title: '改大纲', status: 'running' }));
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
    expect(workItems.value.at(-2)).toMatchObject({ status: 'queued' });
    expect(workItems.value.at(-1)).toMatchObject({ status: 'running' });

    runtime.emit('task_started');
    expect(workItems.value.at(-1)).toMatchObject({ status: 'running' });

    runtime.emit('task_completed');
    await settleFlush();
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
    // ①同款协议：改方向的返回值同样不给可润色状态，结果只认 [BACKEND] 回流
    expect(result).toContain('改了方向');
    expect(result).toContain('[BACKEND]');
    expect(result).not.toMatch(/排队|后台|做完了|完成了/);
  });

  // E4（2026-07-30 真机）：模型把给它的指令照着念给用户听——「这件事你开始做了」，
  // 主语错乱。台词必须写成即使被整句照读也通顺的用户向第一人称。
  it('派活台词是用户向第一人称，照念也通顺', async () => {
    bind();

    const result = await executeVoiceTool('spawn_task', JSON.stringify({ title: '创建a.txt文件', prompt: '建个文件' }));

    expect(result).toContain('我已经开始做');
    expect(result).toContain('做完马上告诉你');
    // 「你开始做了 / 告诉他」这种第二三人称混写就是真机那句读不懂的话
    expect(result).not.toMatch(/你开始做了|告诉他/);
  });

  it('steer_task 在没活跑时如实说「当成新任务派了」，不假装 steer 成功', async () => {
    bind();
    runtime.status = 'idle';

    const result = await executeVoiceTool('steer_task', JSON.stringify({ instruction: '把首页改成深色' }));

    expect(runtime.interruptAndContinue).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.startTask).toHaveBeenCalled());
    expect(result).toContain('新任务');
    // ①同款协议：这条路也走 spawnSpeechDirective，不给可润色状态
    expect(result).toContain('[BACKEND]');
    expect(result).not.toMatch(/排队|后台|完成了/);
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

  it('已有活在跑时允许不同 lane 再派一件', async () => {
    bind();
    runtime.status = 'running';

    const result = await executeVoiceTool('spawn_task', JSON.stringify({ title: 'b', prompt: '再干一件' }));

    expect(runtime.startTask).toHaveBeenCalledTimes(1);
    expect(result).toContain('我已经开始做');
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
    // 证据查询没落地之前票不还——抬严多罩一拍是安全方向，但绝不允许永不返回
    // （所以查询自带超时，见 VOICE_WORK_EVIDENCE_TIMEOUT_MS）。
    await settleFlush();
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
    await settleFlush();
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
