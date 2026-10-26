// ============================================================================
// toolGrantStore 懒绑定不缓存失败（N-PERM-GRANT-TIERS rework r2 Important 2）
// ----------------------------------------------------------------------------
// 缺陷形状：懒绑定第一次失败（db 未初始化 / 查询抛错）就把 null repo 缓存成
// 永久 store，此后每一次 24h 铸权都静默 no-op，直到设置页重绑。修法对齐
// appGrantStore.currentStore：失败不落缓存、每次调用重试，db-null 与 catch
// 两条分支各留一条可区分的 warn。
// 钉子：先 db 不可用（两种失败形态各一）→ 铸权落空；db 可用后同一入口铸权
// 落库（直接 SQL 读行）——证明失败没有被缓存住。
// 隔离：绑定状态是模块级，用例间用 vi.resetModules() + 动态 import 取全新
// 模块实例（显式 reset 导出会进生产 API 面，不做）。
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const state = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
  throws: false,
  warns: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const record = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    state.warns.push({ level, message, ...meta });
  };
  const fake = {
    info: record('info'), debug: record('debug'),
    warn: record('warn'), error: record('error'),
  };
  return { createLogger: () => fake, logger: fake, default: fake };
});

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    if (state.throws) throw new Error('probe: database service down');
    return { getDb: () => state.db };
  },
}));

import { applyToolGrantsSchema } from '../../../src/host/services/core/database/schemaToolGrants';
import { TOOL_GRANT_TIERS } from '../../../src/shared/constants/timeouts';
import type { matchToolGrant as MatchToolGrant, mintTool24hGrant as MintTool24h, mintToolRunGrant as MintToolRun } from '../../../src/host/permissions/toolGrantStore';

const T0 = 1_700_000_000_000;
const DAY = TOOL_GRANT_TIERS.TIER_24H_MS;
const silentLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Parameters<typeof applyToolGrantsSchema>[1];

function toolGrantRows(db: BetterSqlite3.Database): Array<{ tool_name: string; target: string | null; expires_at: number }> {
  return db.prepare('SELECT tool_name, target, expires_at FROM tool_permission_grants').all() as Array<{ tool_name: string; target: string | null; expires_at: number }>;
}

/** 绑定状态是模块级单例：每个用例取全新模块实例，懒路径从未绑定起步。 */
async function freshStore(): Promise<{ mintTool24hGrant: typeof MintTool24h; mintToolRunGrant: typeof MintToolRun; matchToolGrant: typeof MatchToolGrant }> {
  vi.resetModules();
  return import('../../../src/host/permissions/toolGrantStore');
}

describe('toolGrantStore 懒绑定失败不缓存（rework r2 Important 2）', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyToolGrantsSchema(db, silentLogger);
    state.db = null;
    state.throws = false;
    state.warns = [];
  });

  it('db 未初始化（getDb()=null）→ 本次 no-op + 可区分 warn；db 可用后铸权落库（失败没被缓存）', async () => {
    const { mintTool24hGrant, matchToolGrant } = await freshStore();

    // 第一次：db 不可用。不显式 bind——走模块懒路径。
    mintTool24hGrant('Write', null, T0);
    expect(toolGrantRows(db)).toEqual([]);
    expect(state.warns.some((entry) => entry.level === 'warn' && String(entry.message).includes('not initialised'))).toBe(true);

    // db 晚一拍可用：同一入口再铸，必须落库（旧缺陷在这里永久 no-op）。
    state.db = db;
    mintTool24hGrant('Write', null, T0);
    expect(toolGrantRows(db)).toEqual([
      { tool_name: 'Write', target: null, expires_at: T0 + DAY },
    ]);
    expect(matchToolGrant('any-session', 'Write', null, T0 + 1)).toBe('24h');
  });

  it('getDatabase() 抛错 → catch 分支 warn（与 db-null 可区分）；恢复后铸权落库', async () => {
    const { mintTool24hGrant } = await freshStore();

    state.throws = true;
    mintTool24hGrant('mail_send', 'team@example.com', T0);
    expect(toolGrantRows(db)).toEqual([]);
    expect(state.warns.some((entry) => entry.level === 'warn' && String(entry.message).includes('lazy database bind failed'))).toBe(true);
    expect(state.warns.some((entry) => String(entry.message).includes('not initialised'))).toBe(false);

    state.throws = false;
    state.db = db;
    mintTool24hGrant('mail_send', 'team@example.com', T0);
    expect(toolGrantRows(db)).toEqual([
      { tool_name: 'mail_send', target: 'team@example.com', expires_at: T0 + DAY },
    ]);
  });

  it('db 不可用期间铸的 run 档照常生效，且不被后来首次成功的懒绑定清掉', async () => {
    const { mintToolRunGrant, matchToolGrant } = await freshStore();

    mintToolRunGrant('chat-1', 'Write', null, T0);
    // match 也会尝试懒绑定（db 仍不可用 → warn + 不缓存），run 档命中不受影响。
    expect(matchToolGrant('chat-1', 'Write', null, T0 + 1)).toBe('run');
    state.db = db;
    // 首次成功绑定不清 run 档（清空只发生在重绑/fresh）：本轮任务的授权活到 run 结束。
    expect(matchToolGrant('chat-1', 'Write', null, T0 + 2)).toBe('run');
  });
});
