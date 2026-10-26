// ============================================================================
// set_role_proactivity 工具测试 — 真实 configService（临时数据目录）全链路：
// 合并语义（once_a_day 落每日简报 cron / 话题增删不整换）/ forceConfirm 审批卡复述
// 旧->新 / 拒绝不写 / 未知角色报名单 / 专家 thread 默认目标 / 无人值守挡板。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { RoleProactivityConfig } from '../../../../src/shared/contract/roleAssets';
import type { CanUseToolFn, ToolResult } from '../../../../src/host/protocol/tools';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const mockSession = vi.hoisted(() => ({ value: null as null | { metadata?: Record<string, unknown> } }));
const cronJobs = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
  removed: [] as Array<unknown>,
  existing: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => mockSession.value }),
}));

vi.mock('../../../../src/host/cron/cronService', () => ({
  getCronService: () => ({
    listJobs: () => cronJobs.existing,
    createJob: async (job: Record<string, unknown>) => { cronJobs.created.push(job); return job; },
    updateJob: async (id: unknown, patch: Record<string, unknown>) => { cronJobs.updated.push({ id, patch }); },
    deleteJob: async (id: unknown) => { cronJobs.removed.push(id); },
  }),
}));

// agentRegistry 未初始化：resolveAgent 走 undefined（frontmatter 层不参与，settings 覆盖层说话）
vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: () => undefined,
}));

// 真实 configService（每测试 vi.resetModules 后动态 import，单例指向临时 config.json）。
// CODE_AGENT_WEB_MODE=true 让 getSettingsFromKeychain 短路（不碰真机 Keychain）。
vi.stubEnv('CODE_AGENT_WEB_MODE', 'true');

type ToolModule = typeof import('../../../../src/host/tools/modules/roleAuthoring/setRoleProactivity');
type ConfigMod = typeof import('../../../../src/host/services/core/configService');
type RoleProactivityMod = typeof import('../../../../src/host/services/roleAssets/roleProactivity');
type ModesMod = typeof import('../../../../src/host/permissions/modes');

let toolModule: ToolModule;
let configMod: ConfigMod;
let roleProactivityMod: RoleProactivityMod;
let modesMod: ModesMod;

const allow = vi.fn(async (_toolName: string, _input: Record<string, unknown>, _reason?: string, _hint?: unknown) => ({ allow: true } as const));
const deny = vi.fn(async (_toolName: string, _input: Record<string, unknown>, _reason?: string, _hint?: unknown) => ({ allow: false, reason: 'user denied' } as const));

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-attended',
    workingDir: mockConfigDir.dir,
    abortSignal: { aborted: false } as AbortSignal,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emit: vi.fn(),
    ...overrides,
  };
}

async function seedOverride(roleId: string, config: RoleProactivityConfig): Promise<void> {
  await configMod.getConfigService().updateSettings({
    roleAssets: { proactivity: { roles: { [roleId]: config } } },
  });
}

async function readStoredOverride(roleId: string): Promise<Record<string, unknown> | undefined> {
  const settings = configMod.getConfigService().getSettings();
  return (settings as unknown as {
    roleAssets?: { proactivity?: { roles?: Record<string, Record<string, unknown>> } };
  }).roleAssets?.proactivity?.roles?.[roleId];
}

/** expect(result.ok).toBe(false) 不做类型收窄——统一走这个 helper 拿到收窄后的失败分支 */
function expectFail(result: ToolResult<string>): Extract<ToolResult<string>, { ok: false }> {
  expect(result.ok).toBe(false);
  return result as Extract<ToolResult<string>, { ok: false }>;
}

async function readConfigJsonBytes(): Promise<Buffer> {
  return fs.readFile(path.join(mockConfigDir.dir, 'config.json'));
}

beforeEach(async () => {
  mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'set-role-proactivity-'));
  mockSession.value = null;
  cronJobs.created = []; cronJobs.updated = []; cronJobs.removed = []; cronJobs.existing = [];
  vi.resetModules();
  toolModule = await import('../../../../src/host/tools/modules/roleAuthoring/setRoleProactivity');
  configMod = await import('../../../../src/host/services/core/configService');
  roleProactivityMod = await import('../../../../src/host/services/roleAssets/roleProactivity');
  modesMod = await import('../../../../src/host/permissions/modes');
  const service = configMod.getConfigService() as unknown as { configPath: string; initialize: () => Promise<void> };
  service.configPath = path.join(mockConfigDir.dir, 'config.json');
  await service.initialize();
  // 两个持久化角色：研究员（主要目标）与 写手（占位，名单断言用）
  await fs.mkdir(path.join(mockConfigDir.dir, 'roles', '研究员'), { recursive: true });
  await fs.mkdir(path.join(mockConfigDir.dir, 'roles', '写手'), { recursive: true });
  allow.mockClear(); deny.mockClear();
});

afterEach(async () => {
  await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
});

describe('set_role_proactivity（真实 configService，临时数据目录）', () => {
  it('① once_a_day + 不提天气：realtime(每3小时) -> daily(每天09:00)，exclude 在原列表上追加', async () => {
    await seedOverride('研究员', {
      level: 'realtime',
      cadence: '0 0 */3 * * *',
      topicsExclude: ['股票'],
    });
    const handler = await toolModule.setRoleProactivityModule.createHandler();
    const result = await handler.execute(
      { roleId: '研究员', once_a_day: true, add_exclude: ['天气'] },
      makeCtx(),
      allow,
    );

    expect(result.ok).toBe(true);
    const stored = await readStoredOverride('研究员');
    expect(stored).toMatchObject({
      level: 'daily',
      cadence: '0 0 9 * * *',
      topicsExclude: ['股票', '天气'],
    });
    // 写路径含 cadence cron 同步：为 daily 档注册每天 09:00 的 role-wake job
    expect(cronJobs.created).toHaveLength(1);
    expect(cronJobs.created[0]).toMatchObject({
      schedule: { type: 'cron', expression: '0 0 9 * * *' },
      action: { type: 'role-wake', roleId: '研究员' },
    });
    // ④（host 半）：写后有效配置 = detail IPC 的 proactivity 字段同一读路径
    await expect(roleProactivityMod.resolveRoleProactivityConfig('研究员')).resolves.toMatchObject({
      level: 'daily',
      cadence: '0 0 9 * * *',
      topicsExclude: ['股票', '天气'],
    });
  });

  it('② 审批卡：forceConfirm + 旧->新复述（档位/频率/话题），details 带 before/after', async () => {
    await seedOverride('研究员', {
      level: 'realtime',
      cadence: '0 0 */3 * * *',
      quietHours: { start: '23:00', end: '07:00' },
      topicsExclude: ['股票'],
    });
    const handler = await toolModule.setRoleProactivityModule.createHandler();
    await handler.execute(
      { roleId: '研究员', once_a_day: true, add_exclude: ['天气'] },
      makeCtx(),
      allow,
    );

    expect(allow).toHaveBeenCalledTimes(1);
    const [toolName, , reason, hint] = allow.mock.calls[0] as [string, Record<string, unknown>, string | undefined, Parameters<CanUseToolFn>[3] | undefined];
    expect(toolName).toBe('set_role_proactivity');
    expect(hint).toMatchObject({ forceConfirm: true, sessionId: 'sess-attended', type: 'file_write' });
    expect(reason).toContain('角色「研究员」主动性调整');
    expect(reason).toContain('实时介入');
    expect(reason).toContain('每日简报');
    expect(reason).toContain('每天 09:00');
    expect(reason).toContain('永远别提：+ 天气');
    expect(reason).not.toContain('免打扰时段'); // quiet hours 未动不出现 diff 行
    expect((hint as { details?: { before?: unknown; after?: unknown } })?.details).toMatchObject({
      roleId: '研究员',
      before: { level: 'realtime' },
      after: { level: 'daily', cadence: '0 0 9 * * *' },
    });
  });

  it('① remove_exclude 只移除指定话题，其余保留', async () => {
    await seedOverride('研究员', {
      level: 'daily',
      cadence: '0 0 9 * * *',
      topicsExclude: ['天气', '股票', '基金'],
    });
    const handler = await toolModule.setRoleProactivityModule.createHandler();
    const result = await handler.execute(
      { roleId: '研究员', remove_exclude: ['天气'] },
      makeCtx(),
      allow,
    );

    expect(result.ok).toBe(true);
    expect(await readStoredOverride('研究员')).toMatchObject({
      level: 'daily',
      topicsExclude: ['股票', '基金'],
    });
  });

  it('① 拒绝（deny）：审批卡弹了，但落盘配置逐字节不变', async () => {
    await seedOverride('研究员', {
      level: 'realtime',
      cadence: '0 0 */3 * * *',
      topicsExclude: ['股票'],
    });
    const before = await readConfigJsonBytes();
    const handler = await toolModule.setRoleProactivityModule.createHandler();
    const result = await handler.execute(
      { roleId: '研究员', once_a_day: true, add_exclude: ['天气'] },
      makeCtx(),
      deny,
    );

    const denied = expectFail(result);
    expect(denied.code).toBe('PERMISSION_DENIED');
    expect(deny).toHaveBeenCalledTimes(1); // 审批确实被问了（forceConfirm 卡）
    const after = await readConfigJsonBytes();
    expect(after.equals(before)).toBe(true); // 字节级一致 = 什么都没写
    expect(cronJobs.created).toHaveLength(0); // cron 同步也没跑
  });

  it('② 未知 roleId：报名单，不弹审批卡', async () => {
    const handler = await toolModule.setRoleProactivityModule.createHandler();
    const result = await handler.execute(
      { roleId: '不存在的角色', level: 'daily' },
      makeCtx(),
      allow,
    );

    const unknown = expectFail(result);
    expect(unknown.code).toBe('INVALID_ARGS');
    expect(unknown.error).toContain('Unknown role "不存在的角色"');
    expect(unknown.error).toContain('研究员');
    expect(unknown.error).toContain('写手');
    expect(allow).not.toHaveBeenCalled();
  });

  it('缺 roleId 且会话无专家 thread 标记：报错并给出可用角色', async () => {
    const handler = await toolModule.setRoleProactivityModule.createHandler();
    const result = await handler.execute({ level: 'daily' }, makeCtx(), allow);

    const missing = expectFail(result);
    expect(missing.code).toBe('INVALID_ARGS');
    expect(missing.error).toContain('roleId is required');
    expect(missing.error).toContain('研究员');
    expect(missing.error).toContain('写手');
    expect(allow).not.toHaveBeenCalled();
  });

  it('缺 roleId 时默认取会话专家 thread 的角色', async () => {
    mockSession.value = { metadata: { expertThread: { roleId: '研究员', setAt: 1 } } };
    const handler = await toolModule.setRoleProactivityModule.createHandler();
    const result = await handler.execute({ once_a_day: true }, makeCtx(), allow);

    expect(result.ok).toBe(true);
    expect(await readStoredOverride('研究员')).toMatchObject({ level: 'daily', cadence: '0 0 9 * * *' });
  });

  it('④ 无人值守（cron/巡检/channel 标记）会话直接挡板，不弹卡不写', async () => {
    modesMod.getPermissionModeManager().markUnattendedSession('sess-unattended');
    const handler = await toolModule.setRoleProactivityModule.createHandler();
    const result = await handler.execute(
      { roleId: '研究员', once_a_day: true },
      makeCtx({ sessionId: 'sess-unattended' }),
      allow,
    );

    const blocked = expectFail(result);
    expect(blocked.code).toBe('UNATTENDED_UNSUPPORTED');
    expect(allow).not.toHaveBeenCalled();
    expect(await readStoredOverride('研究员')).toBeUndefined();
  });

  it('quiet_hours：HH:mm 校验 + start=end 拒绝 + null 清除', async () => {
    const handler = await toolModule.setRoleProactivityModule.createHandler();

    const bad1 = await handler.execute(
      { roleId: '研究员', quiet_hours: { start: '25:00', end: '08:00' } },
      makeCtx(), allow,
    );
    expect(expectFail(bad1).code).toBe('INVALID_ARGS');

    const bad2 = await handler.execute(
      { roleId: '研究员', quiet_hours: { start: '22:00', end: '22:00' } },
      makeCtx(), allow,
    );
    expect(expectFail(bad2).code).toBe('INVALID_ARGS');

    await seedOverride('研究员', {
      level: 'daily',
      quietHours: { start: '23:00', end: '07:00' },
    });
    const clear = await handler.execute({ roleId: '研究员', quiet_hours: null }, makeCtx(), allow);
    expect(clear.ok).toBe(true);
    expect(await readStoredOverride('研究员')).toMatchObject({ quietHours: null });

    const set = await handler.execute(
      { roleId: '研究员', quiet_hours: { start: '22:00', end: '08:00' } },
      makeCtx(), allow,
    );
    expect(set.ok).toBe(true);
    expect(await readStoredOverride('研究员')).toMatchObject({
      quietHours: { start: '22:00', end: '08:00' },
    });
  });

  it('once_a_day 与 level 冲突直接拒绝；level 非法值拒绝', async () => {
    const handler = await toolModule.setRoleProactivityModule.createHandler();
    const conflict = await handler.execute(
      { roleId: '研究员', once_a_day: true, level: 'realtime' },
      makeCtx(), allow,
    );
    expect(expectFail(conflict).code).toBe('INVALID_ARGS');

    const badLevel = await handler.execute(
      { roleId: '研究员', level: 'always-on' },
      makeCtx(), allow,
    );
    expect(expectFail(badLevel).code).toBe('INVALID_ARGS');
    expect(allow).not.toHaveBeenCalled();
  });

  it('无变化（no-op）不弹审批卡，直接说明当前配置', async () => {
    await seedOverride('研究员', { level: 'daily', cadence: '0 0 9 * * *' });
    const handler = await toolModule.setRoleProactivityModule.createHandler();
    const result = await handler.execute({ roleId: '研究员', level: 'daily' }, makeCtx(), allow);

    expect(result.ok).toBe(true);
    expect(allow).not.toHaveBeenCalled();
    expect(result.ok === true && result.output).toContain('没有需要变更的内容');
  });
});
