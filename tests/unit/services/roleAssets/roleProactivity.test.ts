// ============================================================================
// Role Proactivity Tests — 醒来循环 / 预算护栏 / 空产物守卫 / event 触发链
// ============================================================================
//
// 确定性覆盖（不依赖模型行为）。E2E（scripts/acceptance/role-proactivity-e2e.ts）
// 中 AC5 的 event 全链路依赖模型 spawn compliance（mimo 实测不稳定），
// event 触发链的胶水逻辑在这里用单测兜底。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const mockOrchestrator = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));
const mockSessionManager = vi.hoisted(() => ({
  getCurrentSessionId: vi.fn(() => null),
  getSession: vi.fn(),
  createSession: vi.fn(),
  archiveSession: vi.fn(),
}));
const mockRunRoleWriteBack = vi.hoisted(() => vi.fn(async () => ({ written: [], skipped: [], historyAppended: true })));
// advance→goal run（P4）：Electron 路径用落库事件读 goal 终态
const mockSessionEvents = vi.hoisted(() => ({ getEventsByType: vi.fn(() => [] as Array<{ eventData?: unknown }>) }));

vi.mock('../../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../../src/main/services/infra/sessionManager', () => ({
  getSessionManager: () => mockSessionManager,
}));

// settings 可变 mock：默认空（= 出厂 silent），各测试按需 opt-in
const mockSettings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../../../src/main/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => mockSettings.value,
    getApiKey: () => '',
  }),
}));

vi.mock('../../../../src/main/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({
    provider: 'xiaomi',
    model: 'mimo-v2.5-pro',
    apiKey: 'test',
    temperature: 0.7,
    maxTokens: 4096,
  }),
}));

vi.mock('../../../../src/main/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => mockOrchestrator,
    setWorkingDirectory: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

vi.mock('../../../../src/main/services/roleAssets/roleWriteBack', () => ({
  runRoleWriteBack: mockRunRoleWriteBack,
}));

vi.mock('../../../../src/main/evaluation/sessionEventService', () => ({
  getSessionEventService: () => mockSessionEvents,
}));

// agentRegistry：测试角色无 frontmatter 配置 → 走 settings / 出厂默认
vi.mock('../../../../src/main/agent/agentRegistry', () => ({
  resolveAgent: () => undefined,
}));

// hooks：RoleWake 事件 fire-and-forget，测试中不关心
vi.mock('../../../../src/main/hooks', () => ({
  createHookManager: () => ({
    initialize: vi.fn(),
    hasHooksFor: () => false,
    triggerRoleWake: vi.fn(),
  }),
}));

import {
  wakeRole,
  recordRoleParticipation,
  triggerEventWakes,
  countWakesToday,
  parseWakeDecision,
  inferAdvanceGoalProposalFromWake,
  resolveRoleProactivityConfig,
  cadenceForConfig,
} from '../../../../src/main/services/roleAssets/roleProactivity';
import { ensureRoleAssetDirs, appendRoleHistory, loadRoleHistory } from '../../../../src/main/services/roleAssets/roleAssetService';
import { ROLE_PROACTIVITY } from '../../../../src/shared/constants';

const RESEARCHER = '研究员';
const TODAY = new Date().toISOString().slice(0, 10);

/** 让 mock 会话管理器返回一次"模型醒来产出" */
function primeWakeRun(decision: string, sessionId = 'wake-session-1'): void {
  mockSessionManager.createSession.mockResolvedValue({ id: sessionId, workingDirectory: undefined });
  mockSessionManager.getSession.mockResolvedValue({
    id: sessionId,
    messages: [
      { id: 'm1', role: 'user', content: 'wake prompt', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: `检查完毕。<decision>${decision}</decision>`, timestamp: 2 },
    ],
  });
  mockOrchestrator.sendMessage.mockResolvedValue(undefined);
}

/** 给角色预埋一条产物履历（绕过空产物守卫） */
async function seedProductHistory(roleId: string): Promise<void> {
  await appendRoleHistory(roleId, {
    date: TODAY,
    artifactLabel: '调研报告',
    artifactRef: '/tmp/report.md',
    summary: '完成初稿',
  });
}

describe('roleProactivity', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-proactivity-'));
    await ensureRoleAssetDirs(RESEARCHER);
    // 出厂默认 silent（opt-in）：醒来循环类测试通过 settings 显式开启每日简报档
    mockSettings.value = { roleAssets: { proactivity: { defaultLevel: 'daily' } } };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // 配置解析与决策解析
  // --------------------------------------------------------------------------

  describe('配置与决策解析', () => {
    it('出厂默认（无任何配置）为静默档：功能默认关闭，opt-in', async () => {
      mockSettings.value = {};
      const config = await resolveRoleProactivityConfig(RESEARCHER);
      expect(config.level).toBe('silent');
      expect(cadenceForConfig(config)).toBeNull();
    });

    it('settings 全局默认开启每日简报档后生效', async () => {
      const config = await resolveRoleProactivityConfig(RESEARCHER);
      expect(config.level).toBe('daily');
      expect(cadenceForConfig(config)).toBe(ROLE_PROACTIVITY.DAILY_BRIEF_CRON);
    });

    it('settings per-role 覆盖优先于全局默认', async () => {
      mockSettings.value = {
        roleAssets: {
          proactivity: {
            defaultLevel: 'daily',
            roles: { [RESEARCHER]: { level: 'realtime', cadence: '0 0 */6 * * *' } },
          },
        },
      };
      const config = await resolveRoleProactivityConfig(RESEARCHER);
      expect(config.level).toBe('realtime');
      expect(cadenceForConfig(config)).toBe('0 0 */6 * * *');
    });

    it('silent 档不产生 cadence', () => {
      expect(cadenceForConfig({ level: 'silent' })).toBeNull();
    });

    it('解析四选一决策标记', () => {
      expect(parseWakeDecision('做完了。<decision>advance</decision>')).toBe('advance');
      expect(parseWakeDecision('<decision>silence</decision>')).toBe('silence');
      expect(parseWakeDecision('<decision> REPORT </decision>')).toBe('report');
    });

    it('解析不出决策时保守兜底为汇报', () => {
      expect(parseWakeDecision('没有任何标记的输出')).toBe('report');
    });

    it('从可验证待办信号推断 advance goal 提案', () => {
      const proposal = inferAdvanceGoalProposalFromWake(
        '我先汇报现状。<decision>report</decision>',
        [
          '- 2026-06-04 | 待办清单 | 下一步需要创建 DONE.md，内容写 done，并用 test -f DONE.md 验证',
        ].join('\n'),
      );

      expect(proposal).toEqual({
        goal: '创建 DONE.md，内容写 done，并用 test -f DONE.md 验证',
        verify: 'test -f DONE.md',
      });
    });

    it('模型给了 goal 提案但误标 report 时仍可升级', () => {
      const proposal = inferAdvanceGoalProposalFromWake(
        '需要继续推进。<goal>创建 DONE.md</goal><verify>test -f DONE.md</verify><decision>report</decision>',
      );

      expect(proposal).toEqual({
        goal: '创建 DONE.md',
        verify: 'test -f DONE.md',
      });
    });
  });

  // --------------------------------------------------------------------------
  // 醒来循环（设计 §3 八步）
  // --------------------------------------------------------------------------

  describe('wakeRole 醒来循环', () => {
    it('出厂默认（silent，无任何配置）下醒来被跳过，不烧 token', async () => {
      mockSettings.value = {};
      await seedProductHistory(RESEARCHER);

      const result = await wakeRole(RESEARCHER, 'cadence');

      expect(result.status).toBe('skipped');
      expect(result.skipReason).toBe('silent_level');
      expect(mockOrchestrator.sendMessage).not.toHaveBeenCalled();
      expect(mockSessionManager.createSession).not.toHaveBeenCalled();
    });

    it('cadence 醒来完整循环：实例化 → 跑实例 → 决策 → 履历（单测版 E2E AC2）', async () => {
      await seedProductHistory(RESEARCHER);
      primeWakeRun('report');

      const result = await wakeRole(RESEARCHER, 'cadence');

      expect(result.status).toBe('completed');
      expect(result.decision).toBe('report');
      expect(mockOrchestrator.sendMessage).toHaveBeenCalledTimes(1);
      // 醒来 prompt 注入了角色上下文（turnSystemContext）+ 迭代数硬上限
      const callOptions = mockOrchestrator.sendMessage.mock.calls[0][2];
      const wakePrompt = mockOrchestrator.sendMessage.mock.calls[0][0];
      expect(wakePrompt).toContain('出现 TODO');
      expect(wakePrompt).toContain('必须选择 advance');
      expect(callOptions.maxIterations).toBe(ROLE_PROACTIVITY.WAKE_MAX_ITERATIONS);
      expect(callOptions.agentOverrideId).toBe(RESEARCHER);
      // 非沉默 → 会话不归档
      expect(mockSessionManager.archiveSession).not.toHaveBeenCalled();
      // 履历追加了醒来记录
      const history = await loadRoleHistory(RESEARCHER, 100);
      const wakeEntries = history.filter((l) => l.includes(ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX));
      expect(wakeEntries.length).toBe(1);
      expect(wakeEntries[0]).toContain('[report]');
    });

    it('advance + <goal> 提案 → 升级为 goal run，回填 advanceGoalStatus（单测版 E2E AC4）', async () => {
      await seedProductHistory(RESEARCHER);
      // 醒来产出：advance 决策 + goal 提案（带 verify）
      const wakeOutput = '我要推进。<goal>创建 DONE.md 标记完成</goal><verify>test -f DONE.md</verify><decision>advance</decision>';
      mockSessionManager.createSession.mockResolvedValue({ id: 'wake-advance-1', workingDirectory: undefined });
      mockSessionManager.getSession.mockResolvedValue({
        id: 'wake-advance-1',
        messages: [{ id: 'm2', role: 'assistant', content: wakeOutput, timestamp: 2 }],
      });
      mockOrchestrator.sendMessage.mockResolvedValue(undefined);
      // Electron 路径从落库事件读 goal 终态 → 预置 goal_complete=met
      mockSessionEvents.getEventsByType.mockReturnValue([{ eventData: { status: 'met' } }]);

      const result = await wakeRole(RESEARCHER, 'cadence');

      expect(result.decision).toBe('advance');
      // 升级为 goal run，终态回填
      expect(result.advanceGoalStatus).toBe('met');
      // 两次 sendMessage：① 侦察醒来 ② goal run
      expect(mockOrchestrator.sendMessage).toHaveBeenCalledTimes(2);
      // 第 2 次（goal run）带 goal 选项且 allowSwarm=false（无人值守不扇出）
      const goalCallOptions = mockOrchestrator.sendMessage.mock.calls[1][2];
      expect(goalCallOptions.goal).toBeDefined();
      expect(goalCallOptions.goal.allowSwarm).toBe(false);
      expect(goalCallOptions.goal.verify).toBe('test -f DONE.md');
      // 履历记 [goal:met]
      const history = await loadRoleHistory(RESEARCHER, 100);
      expect(history.some((l) => l.includes('[goal:met]'))).toBe(true);
    });

    it('report 误判但履历有可验证下一步 → 确定性升级为 advance goal run', async () => {
      await appendRoleHistory(RESEARCHER, {
        date: TODAY,
        artifactLabel: '待办清单',
        artifactRef: '/tmp/todo-list.md',
        summary: '下一步需要创建 DONE.md，内容写 done，并用 test -f DONE.md 验证，还没做',
      });
      primeWakeRun('report', 'wake-inferred-advance-1');
      mockSessionEvents.getEventsByType.mockReturnValue([{ eventData: { status: 'met' } }]);

      const result = await wakeRole(RESEARCHER, 'cadence');

      expect(result.decision).toBe('advance');
      expect(result.advanceGoalStatus).toBe('met');
      expect(mockOrchestrator.sendMessage).toHaveBeenCalledTimes(2);
      const goalCallOptions = mockOrchestrator.sendMessage.mock.calls[1][2];
      expect(goalCallOptions.goal.verify).toBe('test -f DONE.md');
      expect(goalCallOptions.goal.allowSwarm).toBe(false);
      const history = await loadRoleHistory(RESEARCHER, 100);
      expect(history.some((l) => l.includes('[goal:met]'))).toBe(true);
    });

    it('advance 但无 <goal> 提案 → 按普通 advance 处理，不发起 goal run', async () => {
      await seedProductHistory(RESEARCHER);
      primeWakeRun('advance', 'wake-advance-noproposal');

      const result = await wakeRole(RESEARCHER, 'cadence');

      expect(result.decision).toBe('advance');
      expect(result.advanceGoalStatus).toBeUndefined();
      // 只有侦察醒来这一次 sendMessage，没有第二次 goal run
      expect(mockOrchestrator.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('沉默决策 → 会话归档 + 履历记"巡检无需行动"（单测版 E2E AC3 模型路径）', async () => {
      await seedProductHistory(RESEARCHER);
      primeWakeRun('silence', 'wake-session-silence');

      const result = await wakeRole(RESEARCHER, 'cadence');

      expect(result.decision).toBe('silence');
      expect(mockSessionManager.archiveSession).toHaveBeenCalledWith('wake-session-silence');
      const history = await loadRoleHistory(RESEARCHER, 100);
      expect(history.some((l) => l.includes('巡检无需行动'))).toBe(true);
    });

    it('空产物守卫：履历无产物的 cadence 醒来确定性静默，不跑模型', async () => {
      // 不 seed 产物履历
      const result = await wakeRole(RESEARCHER, 'cadence');

      expect(result.status).toBe('completed');
      expect(result.decision).toBe('silence');
      expect(mockOrchestrator.sendMessage).not.toHaveBeenCalled();
      expect(mockSessionManager.createSession).not.toHaveBeenCalled();
      const history = await loadRoleHistory(RESEARCHER, 100);
      expect(history.some((l) => l.includes('巡检无需行动'))).toBe(true);
    });

    it('预算护栏：当天醒来次数达上限 → skipped', async () => {
      await seedProductHistory(RESEARCHER);
      // 预埋 MAX_WAKES_PER_DAY 条今天的醒来记录
      for (let i = 0; i < ROLE_PROACTIVITY.MAX_WAKES_PER_DAY; i++) {
        await appendRoleHistory(RESEARCHER, {
          date: TODAY,
          artifactLabel: `${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}(cadence)`,
          artifactRef: '-',
          summary: `第 ${i + 1} 次醒来`,
        });
      }

      const result = await wakeRole(RESEARCHER, 'cadence');

      expect(result.status).toBe('skipped');
      expect(result.skipReason).toContain('daily_budget_exceeded');
      expect(mockOrchestrator.sendMessage).not.toHaveBeenCalled();
    });

    it('非持久化角色（cron job 指向已删除的角色）醒来直接抛错，不重建目录', async () => {
      await expect(wakeRole('不存在的角色', 'cadence')).rejects.toThrow(/not a persistent role/);
      // 守卫顺序回归：不能因为空产物静默守卫先执行而把已删除角色的目录写出来
      const dirs = await fs.readdir(path.join(mockConfigDir.dir, 'roles'));
      expect(dirs).not.toContain('不存在的角色');
    });

    it('countWakesToday 只统计今天的醒来条目', async () => {
      await appendRoleHistory(RESEARCHER, {
        date: '2020-01-01',
        artifactLabel: `${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}(cadence)`,
        artifactRef: '-',
        summary: '很久以前的醒来',
      });
      await appendRoleHistory(RESEARCHER, {
        date: TODAY,
        artifactLabel: `${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}(event)`,
        artifactRef: '-',
        summary: '今天的醒来',
      });
      expect(await countWakesToday(RESEARCHER)).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // event 触发链（设计 §2.2）— E2E AC5 的确定性兜底
  // --------------------------------------------------------------------------

  describe('event 触发链（recordRoleParticipation → triggerEventWakes）', () => {
    it('长任务跑完触发参与的持久化角色醒来，过滤非持久化参与者', async () => {
      await seedProductHistory(RESEARCHER);
      primeWakeRun('report', 'event-wake-session');

      const runSessionId = 'main-run-session-1';
      // 模拟 subagentExecutor：持久化角色 + 内置瞬时 agent 都记录了参与
      recordRoleParticipation(runSessionId, RESEARCHER);
      recordRoleParticipation(runSessionId, 'explore');

      // 主 run 的会话（非醒来会话）
      mockSessionManager.getSession.mockImplementation(async (id: string) => {
        if (id === runSessionId) {
          return { id: runSessionId, origin: { kind: 'manual' }, messages: [] };
        }
        return {
          id,
          messages: [
            { id: 'm1', role: 'user', content: 'wake', timestamp: 1 },
            { id: 'm2', role: 'assistant', content: '总结完成。<decision>report</decision>', timestamp: 2 },
          ],
        };
      });

      await triggerEventWakes(runSessionId, ROLE_PROACTIVITY.LONG_TASK_MIN_TURNS, '主任务的产出摘要');
      // wakeRole 是 fire-and-forget，等微任务清空
      await vi.waitFor(() => {
        expect(mockOrchestrator.sendMessage).toHaveBeenCalledTimes(1);
      });

      // 只有研究员被唤醒（explore 不是持久化角色，被过滤）
      const wakeOptions = mockOrchestrator.sendMessage.mock.calls[0][2];
      expect(wakeOptions.agentOverrideId).toBe(RESEARCHER);
      // 醒来 prompt 带上了 run 的产出摘要（event 触发的额外上下文）
      const wakePrompt = mockOrchestrator.sendMessage.mock.calls[0][0];
      expect(wakePrompt).toContain('主任务的产出摘要');
      expect(wakePrompt).toContain('任务结束事件唤醒');
      // 履历记录为 event 触发
      await vi.waitFor(async () => {
        const history = await loadRoleHistory(RESEARCHER, 100);
        expect(history.some((l) => l.includes(`${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}(event)`))).toBe(true);
      });
    });

    it('run 迭代数低于长任务门槛 → 不触发且清空参与记录', async () => {
      await seedProductHistory(RESEARCHER);
      primeWakeRun('report');

      const runSessionId = 'short-run-session';
      recordRoleParticipation(runSessionId, RESEARCHER);

      await triggerEventWakes(runSessionId, ROLE_PROACTIVITY.LONG_TASK_MIN_TURNS - 1);

      expect(mockOrchestrator.sendMessage).not.toHaveBeenCalled();
      // 参与记录已被清空：再次以足够迭代数触发也不会醒（防止跨 run 污染）
      await triggerEventWakes(runSessionId, ROLE_PROACTIVITY.LONG_TASK_MIN_TURNS);
      expect(mockOrchestrator.sendMessage).not.toHaveBeenCalled();
    });

    it('没有任何角色参与的 run 不触发', async () => {
      await triggerEventWakes('no-participation-session', ROLE_PROACTIVITY.LONG_TASK_MIN_TURNS);
      expect(mockOrchestrator.sendMessage).not.toHaveBeenCalled();
    });

    it('防递归：醒来会话自己结束不再触发 event 醒来', async () => {
      await seedProductHistory(RESEARCHER);
      primeWakeRun('report');

      const wakeSessionId = 'wake-session-itself';
      recordRoleParticipation(wakeSessionId, RESEARCHER);
      // 该会话是醒来会话（origin.name = cadence job tag）
      mockSessionManager.getSession.mockResolvedValue({
        id: wakeSessionId,
        origin: { kind: 'cron', name: ROLE_PROACTIVITY.CADENCE_JOB_TAG },
        messages: [],
      });

      await triggerEventWakes(wakeSessionId, ROLE_PROACTIVITY.LONG_TASK_MIN_TURNS);

      expect(mockOrchestrator.sendMessage).not.toHaveBeenCalled();
    });
  });
});
