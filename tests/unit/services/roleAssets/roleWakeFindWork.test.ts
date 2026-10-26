// ============================================================================
// RoleWakeFindWork Tests — 空履历 + 已连接源的「外部增量」巡检
// ① wakeRole 行为：空履历有源跑模型且 prompt 带增量段 / 无源维持静默 / 前置闸不松动 /
//    排除话题过滤提议 / 至多 2 条 / 同题去重（pending + 搁置期 dismissed）
// ② 解析容错：坏 JSON / 无围栏 / 5 条截断 / 空字段（经 storeWakeProposalsFromWake 落盘观察，
//    解析器私有，行为即契约 —— 同 roleFirstWake 先例）
// ============================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const harness = vi.hoisted(() => {
  const mockSessionManager = {
    getCurrentSessionId: vi.fn(() => null),
    getSession: vi.fn(),
    createSession: vi.fn(),
    archiveSession: vi.fn(),
    updateMessage: vi.fn(),
  };
  const mockOrchestrator = { sendMessage: vi.fn() };
  return {
    configDir: { dir: '' },
    mockSessionManager,
    mockOrchestrator,
    mockSessionAutomation: {
      recordCreated: vi.fn(),
      recordEvent: vi.fn(),
    },
    mockSessionEvents: { getEventsByType: vi.fn(() => []) },
    mockSettings: { value: {} as Record<string, unknown> },
    // 能力中心：默认无已连接源，各测试按需注入
    listCapabilities: vi.fn(async (): Promise<{ items: CapabilityCenterItem[] }> => ({ items: [] })),
  };
});

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => harness.configDir.dir,
  getAgentsMdDir: () => ({ user: path.join(harness.configDir.dir, 'agents') }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => harness.mockSessionManager,
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => harness.mockSettings.value,
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
    getOrCreateCurrentOrchestrator: () => harness.mockOrchestrator,
    setWorkingDirectory: vi.fn(),
    cleanup: vi.fn(),
  }),
}));
vi.mock('../../../../src/host/services/roleAssets/roleWriteBack', () => ({
  runRoleWriteBack: vi.fn(async () => ({ written: [], skipped: [], historyAppended: true })),
}));
vi.mock('../../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => harness.mockSessionAutomation,
}));
vi.mock('@host/session/sessionEventService', () => ({
  getSessionEventService: () => harness.mockSessionEvents,
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: () => undefined,
}));
vi.mock('../../../../src/host/hooks', () => ({
  createHookManager: () => ({
    initialize: vi.fn(),
    hasHooksFor: () => false,
    triggerRoleWake: vi.fn(),
  }),
}));
vi.mock('../../../../src/host/services/capabilities/capabilityCenterService', () => ({
  getCapabilityCenterService: () => ({ listCapabilities: harness.listCapabilities }),
}));

import { wakeRole } from '../../../../src/host/services/roleAssets/roleProactivity';
import {
  acceptWakeProposal,
  dismissWakeProposal,
  listWakeProposals,
  storeWakeProposalsFromWake,
} from '../../../../src/host/services/roleAssets/roleWakeFindWork';
import { appendRoleHistory, ensureRoleAssetDirs, loadRoleHistory } from '../../../../src/host/services/roleAssets/roleAssetService';
import { getRoleWakeProposalsPath } from '../../../../src/host/services/roleAssets/roleAssetPaths';
import { ROLE_PROACTIVITY } from '../../../../src/shared/constants';
import type { CapabilityCenterItem } from '../../../../src/shared/contract/capability';

const RESEARCHER = '研究员';
const TODAY = new Date().toISOString().slice(0, 10);

/** 一个用户自连的 connector 源（判据见 roleFirstWake.isUserConnectedSource）。 */
function connectedSource(name: string): CapabilityCenterItem {
  return {
    name,
    kind: 'connector',
    state: { runtime: 'connected' },
    source: { kind: 'builtin' },
    tags: [],
  } as unknown as CapabilityCenterItem;
}

function primeConnectedSources(names: string[]): void {
  harness.listCapabilities.mockImplementation(async () => ({
    items: names.map(connectedSource),
  }));
}

/** 让 mock 会话管理器返回一次模型醒来产出。 */
function primeWakeOutput(content: string, sessionId = 'wake-findwork-1'): void {
  harness.mockSessionManager.createSession.mockResolvedValue({ id: sessionId, workingDirectory: undefined });
  harness.mockSessionManager.getSession.mockResolvedValue({
    id: sessionId,
    messages: [
      { id: 'm1', role: 'user', content: 'wake prompt', timestamp: 1 },
      { id: 'm2', role: 'assistant', content, timestamp: 2 },
    ],
  });
  harness.mockOrchestrator.sendMessage.mockResolvedValue(undefined);
}

/** 给角色预埋一条产物履历（绕过空产物守卫）。 */
async function seedProductHistory(roleId: string): Promise<void> {
  await appendRoleHistory(roleId, {
    date: TODAY,
    artifactLabel: '调研报告',
    artifactRef: '/tmp/report.md',
    summary: '完成初稿',
  });
}

async function readStoredProposals(roleId: string): Promise<{ title: string; prompt: string }[]> {
  const raw = await fs.readFile(getRoleWakeProposalsPath(roleId), 'utf-8');
  return JSON.parse(raw).proposals;
}

async function seedProposalsFile(roleId: string, state: unknown): Promise<void> {
  const filePath = getRoleWakeProposalsPath(roleId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

const PROPOSALS_FENCE = (items: unknown): string =>
  '```wake_proposals\n' + JSON.stringify(items) + '\n```';

describe('roleWakeFindWork — ① wakeRole 行为', () => {
  beforeEach(async () => {
    harness.configDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-findwork-'));
    await ensureRoleAssetDirs(RESEARCHER);
    harness.mockSettings.value = { roleAssets: { proactivity: { defaultLevel: 'daily' } } };
    vi.clearAllMocks();
    harness.listCapabilities.mockImplementation(async () => ({ items: [] }));
  });
  afterEach(async () => {
    await fs.rm(harness.configDir.dir, { recursive: true, force: true });
  });

  it('空履历 + 已连接源：模型被调用，prompt 带外部增量段（点名源与冷线索判据）', async () => {
    primeConnectedSources(['mail', 'calendar']);
    primeWakeOutput(`巡检完成，暂无要紧事。\n${PROPOSALS_FENCE([{ title: '催一下报价', prompt: '起草一封跟进报价的邮件草稿' }])}\n<decision>silence</decision>`);
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.status).toBe('completed');
    expect(harness.mockOrchestrator.sendMessage).toHaveBeenCalledTimes(1);
    const wakePrompt = harness.mockOrchestrator.sendMessage.mock.calls[0][0] as string;
    expect(wakePrompt).toContain('还没有经手过的产物');
    expect(wakePrompt).toContain('已连接源：mail、calendar');
    expect(wakePrompt).toContain('新邮件：上次醒来之后新收到的邮件');
    expect(wakePrompt).toContain(`超过 ${ROLE_PROACTIVITY.STALE_REPLY_DAYS} 天`);
    expect(wakePrompt).toContain('未读取');
    expect(wakePrompt).toContain('wake_proposals');
    // 提议落盘
    expect(await readStoredProposals(RESEARCHER)).toHaveLength(1);
  });

  it('空履历 + 无已连接源：维持既有静默，不烧模型 token', async () => {
    primeWakeOutput('不应被调用');
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.status).toBe('completed');
    expect(result.decision).toBe('silence');
    expect(harness.mockOrchestrator.sendMessage).not.toHaveBeenCalled();
    const history = await loadRoleHistory(RESEARCHER, 100);
    expect(history.some((l) => l.includes('履历中没有产物'))).toBe(true);
  });

  it('前置闸不松动：silent 档（有源也跳过）', async () => {
    primeConnectedSources(['mail']);
    harness.mockSettings.value = {};
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('silent_level');
    expect(harness.mockOrchestrator.sendMessage).not.toHaveBeenCalled();
  });

  it('前置闸不松动：日预算 4 次（有源也跳过）', async () => {
    primeConnectedSources(['mail']);
    for (let i = 0; i < ROLE_PROACTIVITY.MAX_WAKES_PER_DAY; i++) {
      await appendRoleHistory(RESEARCHER, {
        date: TODAY,
        artifactLabel: `${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}（cadence）`,
        artifactRef: '-',
        summary: `第 ${i + 1} 次醒来`,
      });
    }
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe(`daily_budget_exceeded (${ROLE_PROACTIVITY.MAX_WAKES_PER_DAY}/${ROLE_PROACTIVITY.MAX_WAKES_PER_DAY})`);
    expect(harness.mockOrchestrator.sendMessage).not.toHaveBeenCalled();
  });

  it('前置闸不松动：免打扰时段（有源也跳过）', async () => {
    primeConnectedSources(['mail']);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(`${TODAY}T02:30:00`));
      harness.mockSettings.value = {
        roleAssets: { proactivity: { roles: { [RESEARCHER]: { level: 'daily', quietHours: { start: '23:00', end: '08:00' } } } } },
      };
      const result = await wakeRole(RESEARCHER, 'cadence');
      expect(result.status).toBe('skipped');
      expect(result.skipReason).toBe('quiet_hours');
      expect(harness.mockOrchestrator.sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('履历有产物 + 有源：prompt 同样带增量段（并行巡检口径）', async () => {
    await seedProductHistory(RESEARCHER);
    primeConnectedSources(['calendar']);
    primeWakeOutput('检查完毕。<decision>report</decision>');
    await wakeRole(RESEARCHER, 'cadence');
    const wakePrompt = harness.mockOrchestrator.sendMessage.mock.calls[0][0] as string;
    expect(wakePrompt).toContain('外部数据源巡检');
    expect(wakePrompt).toContain('与产物巡检并行');
    expect(wakePrompt).toContain('出现 TODO'); // 基础四选一段原样保留
  });

  it('排除话题命中 → 该提议被丢弃，其余保留', async () => {
    primeConnectedSources(['mail']);
    harness.mockSettings.value = {
      roleAssets: { proactivity: { roles: { [RESEARCHER]: { level: 'daily', topicsExclude: ['股票'] } } } },
    };
    primeWakeOutput(`巡检完成。\n${PROPOSALS_FENCE([
      { title: '复盘股票持仓', prompt: '起草股票复盘草稿' },
      { title: '催一下报价', prompt: '起草跟进报价的邮件草稿' },
    ])}\n<decision>report</decision>`);
    await wakeRole(RESEARCHER, 'cadence');
    const stored = await readStoredProposals(RESEARCHER);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('催一下报价');
  });

  it('全源「未读取」+ 模型选沉默 → 纠正为 report（点名故障，不许静默）', async () => {
    primeConnectedSources(['mail']);
    primeWakeOutput('mail 读取失败。未读取：mail\n<decision>silence</decision>');
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.decision).toBe('report');
  });

  it('IPC 面：list / accept（返回 prompt 并移除）/ dismiss（移入 dismissed）', async () => {
    await seedProposalsFile(RESEARCHER, {
      proposals: [{ title: '改期 14:00 会议', prompt: '拟一封改期邮件草稿', createdAt: '2026-10-26T01:00:00.000Z' }],
      dismissed: [],
    });
    expect(await listWakeProposals(RESEARCHER)).toHaveLength(1);
    const accepted = await acceptWakeProposal(RESEARCHER, '改期 14:00 会议');
    expect(accepted?.prompt).toBe('拟一封改期邮件草稿');
    expect(await listWakeProposals(RESEARCHER)).toHaveLength(0);
    // 重新播种再 dismiss
    await seedProposalsFile(RESEARCHER, {
      proposals: [{ title: '催报价', prompt: 'x', createdAt: '2026-10-26T01:00:00.000Z' }],
      dismissed: [],
    });
    expect(await dismissWakeProposal(RESEARCHER, '催报价')).toEqual({ success: true });
    expect(await listWakeProposals(RESEARCHER)).toHaveLength(0);
    const state = JSON.parse(await fs.readFile(getRoleWakeProposalsPath(RESEARCHER), 'utf-8'));
    expect(state.dismissed[0].title).toBe('催报价');
  });

  it('同题去重：pending 同题不再入库；dismissed 搁置期内同题不再入库', async () => {
    // pending 同题
    await seedProposalsFile(RESEARCHER, {
      proposals: [{ title: '催一下报价', prompt: '旧', createdAt: '2026-10-25T01:00:00.000Z' }],
      dismissed: [],
    });
    const stored1 = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: PROPOSALS_FENCE([
        { title: '催一下报价', prompt: '新' },
        { title: '改期 14:00 会议', prompt: '拟改期邮件' },
      ]),
    });
    expect(stored1).toBe(1);
    expect((await readStoredProposals(RESEARCHER)).map((p) => p.title)).toEqual(['催一下报价', '改期 14:00 会议']);
    // dismissed 搁置期内同题
    await seedProposalsFile(RESEARCHER, {
      proposals: [],
      dismissed: [{ title: '催一下报价', dismissedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }],
    });
    const stored2 = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: PROPOSALS_FENCE([{ title: '催一下报价', prompt: '又来了' }]),
    });
    expect(stored2).toBe(0);
    expect(await readStoredProposals(RESEARCHER)).toHaveLength(0);
  });
});

describe('roleWakeFindWork — ② 解析容错（经落盘观察）', () => {
  beforeEach(async () => {
    harness.configDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-findwork-2-'));
    await ensureRoleAssetDirs(RESEARCHER);
  });
  afterEach(async () => {
    await fs.rm(harness.configDir.dir, { recursive: true, force: true });
  });

  it('坏 JSON → 不落盘也不炸', async () => {
    const stored = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: '```wake_proposals\n[{broken json\n```',
    });
    expect(stored).toBe(0);
    await expect(fs.readFile(getRoleWakeProposalsPath(RESEARCHER), 'utf-8')).rejects.toThrow();
  });

  it('无围栏 → 0', async () => {
    const stored = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: '没有提议块。\n<decision>silence</decision>',
    });
    expect(stored).toBe(0);
  });

  it('5 条 → 截到 MAX_PROPOSALS=2', async () => {
    const stored = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: PROPOSALS_FENCE([1, 2, 3, 4, 5].map((i) => ({ title: `提议${i}`, prompt: `委托${i}` }))),
    });
    expect(stored).toBe(ROLE_PROACTIVITY.MAX_PROPOSALS);
    expect(await readStoredProposals(RESEARCHER)).toHaveLength(2);
  });

  it('空 title / 空 prompt → 丢弃，合法项保留', async () => {
    const stored = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: PROPOSALS_FENCE([
        { title: '', prompt: '有 prompt 没 title' },
        { title: '只有标题', prompt: '   ' },
        { title: '合法提议', prompt: '起草草稿' },
      ]),
    });
    expect(stored).toBe(1);
    expect((await readStoredProposals(RESEARCHER))[0].title).toBe('合法提议');
  });
});
