// ============================================================================
// 工具授权两档（N-PERM-GRANT-TIERS）—— 验收 ②③④⑤⑥ 的 host 侧钉子
// ============================================================================
// 真 in-memory SQLite 装 tool_permission_grants 表；审批岛走公开入口
// requestPermission / handlePermissionResponse。锁：
//   ② run 档：同会话第二次同类调用免询问（resolvePreAskGrant 命中）、
//      run 结束清除后恢复询问、别的会话永不命中、target 精确一致；
//   ③ 24h 档：到期前命中、grantedAt+24h 起不命中（注入时钟）、重绑（模拟重启）
//      仍命中、建表迁移幂等（跑两次）；
//   ④ 停车审批（cron 收件箱）allow_run 铸 run 档，只对该运行会话生效；
//   ⑤ 台账列两档（kind tool-timed + source 区分档位 + 24h 档 expiresAt），
//      撤销后下一次按从未授权；无 agent 可调用工具暴露 list/revoke；
//   ⑥ 共享契约放行判定覆盖两个新值；改过的参数配新档仍 fail-closed。
// 反向变异：把 toolGrantStore.match 的 run 档分支注掉 / 把过期判定倒过来，
// 对应用例必红（见证据档）。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const state = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
}));

vi.mock('../../../src/host/platform', () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => state.db,
  }),
}));

vi.mock('../../../src/host/services/sessionAutomation/sessionAutomationService', () => ({
  getSessionAutomationService: () => ({
    matchStandingGrant: vi.fn(() => false),
    mintStandingGrant: vi.fn(() => true),
    listStandingGrantEntries: vi.fn(() => []),
  }),
}));

import { applyToolGrantsSchema } from '../../../src/host/services/core/database/schemaToolGrants';
import { TOOL_GRANT_TIERS } from '../../../src/shared/constants/timeouts';
import {
  bindToolGrantDatabase,
  clearToolRunGrants,
  listToolGrants,
  matchToolGrant,
  mintTool24hGrant,
  mintToolRunGrant,
  revokeTool24hGrant,
  revokeToolRunGrant,
} from '../../../src/host/permissions/toolGrantStore';
import { resolvePreAskGrant } from '../../../src/host/permissions/preAskGrant';
import { listGrants, revokeGrant } from '../../../src/host/permissions/grantLedger';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { approvalAnswerFromPermission } from '../../../src/host/services/companion/companionDecisionSink';
import { isApprovePermissionResponse } from '../../../src/shared/contract/permission';
import type { AppSettings, PermissionAskResult } from '../../../src/shared/contract';
import type { PermissionRequest } from '../../../src/shared/contract/permission';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

const logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Parameters<typeof applyToolGrantsSchema>[1];

const T0 = 1_700_000_000_000;
const DAY = TOOL_GRANT_TIERS.TIER_24H_MS;

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

function makeIsland(opts: { sessionId: string; unattended?: boolean; repo?: PendingApprovalRepository }) {
  const events: { type: string; data: { id: string } }[] = [];
  const island = new OrchestratorPermissionIsland({
    getSettings: settings,
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'main',
    hasApprovalUi: () => true,
    onEvent: (e) => events.push(e as never),
    ...(opts.repo ? { injectedPendingApprovalRepo: opts.repo } : {}),
  });
  if (opts.unattended) getPermissionModeManager().markUnattendedSession(opts.sessionId);
  return {
    island,
    events,
    ask: (request: Partial<Omit<PermissionRequest, 'id' | 'timestamp'>>) => {
      const promise = island.requestPermission({
        type: 'command',
        tool: 'Bash',
        details: {},
        sessionId: opts.sessionId,
        ...request,
      } as Omit<PermissionRequest, 'id' | 'timestamp'>);
      const id = events.find((e) => e.type === 'permission_request')?.data.id;
      if (!id) throw new Error('no permission_request event');
      return { promise, id };
    },
  };
}

/** toolExecutor 判「要不要问用户」用的同一入口：非空 = 免询问放行。 */
function preAsk(sessionId: string, tool: string, standingGrantTarget: string | null = null) {
  return resolvePreAskGrant({
    toolName: tool,
    sessionId,
    standingGrantTarget,
    computerApp: null,
    blocked: false,
  });
}

describe('toolGrantStore ② run 档', () => {
  beforeEach(() => {
    bindToolGrantDatabase(state.db, true);
  });

  it('同会话第二次同类调用命中 run 档；别的会话永不命中', () => {
    mintToolRunGrant('chat-1', 'Write', null, T0);
    expect(matchToolGrant('chat-1', 'Write', null, T0 + 1)).toBe('run');
    expect(matchToolGrant('chat-2', 'Write', null, T0 + 1)).toBe(null);
    expect(preAsk('chat-1', 'Write')?.ledgerReason).toBe('tool_grant:run');
    expect(preAsk('chat-2', 'Write')).toBe(null);
  });

  it('run 结束清除后恢复询问（runFinalizer 同款清除入口）', () => {
    mintToolRunGrant('chat-1', 'Write', null, T0);
    clearToolRunGrants('chat-1');
    expect(matchToolGrant('chat-1', 'Write', null, T0 + 1)).toBe(null);
    expect(preAsk('chat-1', 'Write')).toBe(null);
  });

  it('target 精确一致：null 只匹配 null，别的 target 不放大', () => {
    mintToolRunGrant('chat-1', 'mail_send', 'team@example.com', T0);
    expect(matchToolGrant('chat-1', 'mail_send', 'team@example.com', T0 + 1)).toBe('run');
    expect(matchToolGrant('chat-1', 'mail_send', 'other@example.com', T0 + 1)).toBe(null);
    expect(matchToolGrant('chat-1', 'mail_send', null, T0 + 1)).toBe(null);
    expect(preAsk('chat-1', 'mail_send', 'team@example.com')?.traceRule).toBe('tool_grant:run');
    expect(preAsk('chat-1', 'mail_send', 'other@example.com')).toBe(null);
  });

  it('硬门（blocked）不消费——与既有 standingGrant 同守卫', () => {
    mintToolRunGrant('chat-1', 'Write', null, T0);
    const blocked = resolvePreAskGrant({
      toolName: 'Write',
      sessionId: 'chat-1',
      standingGrantTarget: null,
      computerApp: null,
      blocked: true,
    });
    expect(blocked).toBe(null);
  });
});

describe('toolGrantStore ③ 24h 档', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    state.db = db;
    applyToolGrantsSchema(db, logger);
    bindToolGrantDatabase(db, true);
  });

  afterEach(() => {
    db.close();
    state.db = null;
  });

  it('到期前命中、grantedAt+24h 起不命中（注入时钟）', () => {
    mintTool24hGrant('Write', null, T0);
    expect(matchToolGrant('any-session', 'Write', null, T0 + 1)).toBe('24h');
    expect(matchToolGrant('any-session', 'Write', null, T0 + DAY - 1)).toBe('24h');
    expect(matchToolGrant('any-session', 'Write', null, T0 + DAY)).toBe(null);
    expect(matchToolGrant('any-session', 'Write', null, T0 + DAY + 1)).toBe(null);
    // preAsk 走调用边缺省时钟（真 now）：用真时钟铸造的 grant 验证消费链。
    mintTool24hGrant('Bash', null, Date.now());
    expect(preAsk('other-session', 'Bash')?.ledgerReason).toBe('tool_grant:24h');
  });

  it('expiresAt = grantedAt + 24h；过期条目不列出', () => {
    mintTool24hGrant('Write', null, T0);
    expect(listToolGrants(T0 + 1)).toEqual([
      expect.objectContaining({ tier: '24h', tool: 'Write', target: null, expiresAt: T0 + DAY }),
    ]);
    expect(listToolGrants(T0 + DAY)).toEqual([]);
  });

  it('store 重绑（模拟重启）后仍命中——24h 承诺不因重启失效', () => {
    mintTool24hGrant('Write', 'team@example.com', T0);
    bindToolGrantDatabase(db, true);
    expect(matchToolGrant('any-session', 'Write', 'team@example.com', T0 + 1)).toBe('24h');
  });

  it('run 档优先于 24h 档（更窄的时间盒先消费）', () => {
    mintToolRunGrant('chat-1', 'Write', null, T0);
    mintTool24hGrant('Write', null, T0);
    expect(matchToolGrant('chat-1', 'Write', null, T0 + 1)).toBe('run');
  });

  it('建表迁移幂等：跑两次不抛、授权照常', () => {
    expect(() => applyToolGrantsSchema(db, logger)).not.toThrow();
    expect(() => applyToolGrantsSchema(db, logger)).not.toThrow();
    mintTool24hGrant('Write', null, T0);
    expect(matchToolGrant('s', 'Write', null, T0 + 1)).toBe('24h');
  });

  it('直接撤权接口撤掉后按从未授权处理', () => {
    mintToolRunGrant('chat-1', 'Write', null, T0);
    mintTool24hGrant('Bash', null, T0);
    expect(revokeToolRunGrant('chat-1', 'Write', null)).toBe(true);
    expect(revokeTool24hGrant('Bash', null)).toBe(true);
    expect(matchToolGrant('chat-1', 'Write', null, T0 + 1)).toBe(null);
    expect(matchToolGrant('s', 'Bash', null, T0 + 1)).toBe(null);
  });
});

describe('审批岛 ②④ 交互与停车路径铸权', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    state.db = db;
    applyToolGrantsSchema(db, logger);
    bindToolGrantDatabase(db, true);
    resetPermissionModeManager();
    getPermissionModeManager();
  });

  afterEach(() => {
    resetPermissionModeManager();
    db.close();
    state.db = null;
  });

  it('② 交互卡 allow_run：本次 run 内同会话免询问，放行语义 = 用户批准', async () => {
    const { island, ask } = makeIsland({ sessionId: 'chat-run-1' });
    const { promise, id } = ask({ details: { command: 'echo hi' } });
    expect(island.handlePermissionResponse(id, 'allow_run')).toBe('delivered');
    const result = (await promise) as PermissionAskResult;
    expect(result).toEqual({ approved: true, approvalSource: 'user' });
    expect(matchToolGrant('chat-run-1', 'Bash', null, Date.now())).toBe('run');
    expect(preAsk('chat-run-1', 'Bash')?.ledgerReason).toBe('tool_grant:run');
    expect(preAsk('chat-run-2', 'Bash')).toBe(null);
  });

  it('② 交互卡 allow_24h：跨会话 24 小时内免询问', async () => {
    const { island, ask } = makeIsland({ sessionId: 'chat-day-1' });
    const { promise, id } = ask({ tool: 'Write', type: 'file_write', details: { path: '/tmp/x.txt' } });
    expect(island.handlePermissionResponse(id, 'allow_24h')).toBe('delivered');
    expect(await promise).toMatchObject({ approved: true, approvalSource: 'user' });
    expect(matchToolGrant('chat-day-1', 'Write', null, Date.now())).toBe('24h');
    expect(matchToolGrant('totally-other-session', 'Write', null, Date.now())).toBe('24h');
  });

  it('④ 停车审批（cron 收件箱）allow_run：铸 (运行会话, 工具, target) run 档', async () => {
    const repo = { insert: vi.fn(), resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository;
    const { island, ask } = makeIsland({ sessionId: 'cron-run-9', unattended: true, repo });
    const { promise, id } = ask({
      tool: 'mail_send',
      type: 'mcp',
      details: { command: undefined, standingGrantTarget: 'team@example.com' },
    });
    expect(island.handlePermissionResponse(id, 'allow_run')).toBe('delivered');
    expect(await promise).toMatchObject({ approved: true, approvalSource: 'user' });
    // 只在这个运行会话里、对同一 target 免询问；别的 target / 下一次 cron 运行（新会话）都问。
    expect(matchToolGrant('cron-run-9', 'mail_send', 'team@example.com', Date.now())).toBe('run');
    expect(matchToolGrant('cron-run-10', 'mail_send', 'team@example.com', Date.now())).toBe(null);
    expect(matchToolGrant('cron-run-9', 'mail_send', 'someone@example.com', Date.now())).toBe(null);
  });

  it('④ 停车审批 allow_24h 同样铸权（target 从透传字段取）', async () => {
    const repo = { insert: vi.fn(), resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository;
    const { island, ask } = makeIsland({ sessionId: 'cron-run-11', unattended: true, repo });
    const { promise, id } = ask({
      tool: 'mail_send',
      type: 'mcp',
      details: { standingGrantTarget: 'ops@example.com' },
    });
    expect(island.handlePermissionResponse(id, 'allow_24h')).toBe('delivered');
    expect(await promise).toMatchObject({ approved: true });
    expect(matchToolGrant('anywhere', 'mail_send', 'ops@example.com', Date.now())).toBe('24h');
  });

  it('改过的参数配两档新值仍 fail-closed（只配一次性 allow）', async () => {
    const { island, ask } = makeIsland({ sessionId: 'chat-edit-1' });
    const run = ask({
      tool: 'mail_send',
      details: { to: ['a@x.com'] } as unknown as PermissionRequest['details'],
    });
    island.handlePermissionResponse(run.id, 'allow_run', { to: ['b@x.com'] });
    expect(await run.promise).toMatchObject({ approved: false, denialSource: 'fail-closed' });
    expect(matchToolGrant('chat-edit-1', 'mail_send', null, Date.now())).toBe(null);
  });

  it('allow_run 无 sessionId（重启恢复等无会话应答）→ 不铸造任何 run 档（fail-safe，rework r2 nit）', async () => {
    const { island, ask } = makeIsland({ sessionId: 'chat-nosession-1' });
    const { promise, id } = ask({ sessionId: undefined, details: { command: 'echo hi' } });
    expect(island.handlePermissionResponse(id, 'allow_run')).toBe('delivered');
    // 本次照常放行，但不落任何 run 档记忆：无处归属的时间盒不放大。
    expect(await promise).toEqual({ approved: true, approvalSource: 'user' });
    expect(matchToolGrant('chat-nosession-1', 'Bash', null, Date.now())).toBe(null);
  });
});

describe('⑤ 统一授权台账列两档', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    state.db = db;
    applyToolGrantsSchema(db, logger);
    applyToolGrantsSchema(db, logger);
    bindToolGrantDatabase(db, true);
  });

  afterEach(() => {
    db.close();
    state.db = null;
  });

  it('run 档与 24h 档都列出：kind tool-timed、source 即档位、24h 档带 expiresAt；id 稳定可解析', () => {
    mintToolRunGrant('chat-1', 'mail_send', 'team@example.com', T0);
    mintTool24hGrant('Write', null, T0);
    const entries = listGrants(T0 + 1).filter((entry) => entry.kind === 'tool-timed');
    expect(entries).toHaveLength(2);

    const run = entries.find((entry) => entry.source === 'run');
    expect(run).toMatchObject({
      kind: 'tool-timed',
      label: 'mail_send',
      detail: 'team@example.com',
      grantedAt: T0,
      expiresAt: null,
    });
    expect(run?.id).toBe(`tool-run:${encodeURIComponent('chat-1')}:${encodeURIComponent('mail_send')}:${encodeURIComponent('team@example.com')}`);

    const day = entries.find((entry) => entry.source === '24h');
    expect(day).toMatchObject({
      kind: 'tool-timed',
      label: 'Write',
      grantedAt: T0,
      expiresAt: T0 + DAY,
    });
    expect(day?.id).toBe(`tool-24h:${encodeURIComponent('Write')}`);
  });

  it('撤销（经台账 id）后下一次同类操作按从未授权；过期 24h 档不列出', () => {
    mintToolRunGrant('chat-1', 'Bash', null, T0);
    mintTool24hGrant('Write', null, T0);
    expect(matchToolGrant('chat-1', 'Bash', null, T0 + 1)).toBe('run');
    expect(matchToolGrant('s', 'Write', null, T0 + 1)).toBe('24h');

    expect(revokeGrant(`tool-run:${encodeURIComponent('chat-1')}:${encodeURIComponent('Bash')}`)).toBe(true);
    expect(revokeGrant(`tool-24h:${encodeURIComponent('Write')}`)).toBe(true);
    expect(matchToolGrant('chat-1', 'Bash', null, T0 + 2)).toBe(null);
    expect(matchToolGrant('s', 'Write', null, T0 + 2)).toBe(null);

    mintTool24hGrant('Write', null, T0);
    expect(listGrants(T0 + DAY).some((entry) => entry.id.startsWith('tool-24h:'))).toBe(false);
  });

  it('没有任何 agent 可调用工具暴露工具授权的 list/revoke（no-self-revoke）', async () => {
    const { getProtocolRegistry } = await import('../../../src/host/tools/protocolRegistry');
    const schemas = getProtocolRegistry().getSchemas();
    const forbidden = [
      'listToolGrants', 'revokeToolGrant', 'revokeToolRunGrant', 'revokeTool24hGrant',
      'mintToolRunGrant', 'mintTool24hGrant', 'clearToolRunGrants', 'matchToolGrant',
    ];
    expect(schemas.filter((schema) => forbidden.includes(schema.name))).toEqual([]);
    expect(schemas.filter((schema) => forbidden.some((name) => JSON.stringify(schema).includes(name))).map((schema) => schema.name)).toEqual([]);
  });
});

describe('⑥ 契约放行判定与 companion 口径', () => {
  it('isApprovePermissionResponse 覆盖全部允许形态（含两档新值）', () => {
    expect(isApprovePermissionResponse('allow')).toBe(true);
    expect(isApprovePermissionResponse('allow_session')).toBe(true);
    expect(isApprovePermissionResponse('allow_standing')).toBe(true);
    expect(isApprovePermissionResponse('allow_run')).toBe(true);
    expect(isApprovePermissionResponse('allow_24h')).toBe(true);
    expect(isApprovePermissionResponse('deny')).toBe(false);
  });

  it('companion 回执把两档新值归 allow_session 档（时间盒放行，非永久 approved）', () => {
    expect(approvalAnswerFromPermission('allow_run')).toEqual({ decision: 'allow_session' });
    expect(approvalAnswerFromPermission('allow_24h')).toEqual({ decision: 'allow_session' });
    expect(approvalAnswerFromPermission('allow')).toEqual({ decision: 'approved' });
    expect(approvalAnswerFromPermission('deny')).toEqual({ decision: 'rejected' });
  });
});
