// ============================================================================
// 工具授权两档（N-PERM-GRANT-TIERS）：run 档 + 24h 档
// ============================================================================
// 审批卡「到这次做完为止」/「24 小时内允许」的真源。与 renderer 权限记忆
// （permissionStore，进程内存 + localStorage，host 与无人值守面看不见）不同，
// 这里归 host 持有：cron/停车审批、手机 companion 应答与设置页台账都消费同一份。
//
//   run 档：key = sessionId + tool [+ target]，只活在本进程 Map。run 结束由
//           runFinalizer 统一清除（对话里 = 本轮任务做完；cron = 本次运行）。
//           进程重启即失效 = 下一次询问，fail-safe。
//   24h 档：key = tool [+ target]，expiresAt = grantedAt + 24h，落
//           tool_permission_grants 表（schemaToolGrants），重启不破坏承诺。
//
// 匹配 key 纪律：铸造与消费两侧的 target 都取 toolExecutor 透传的
// standingGrantTarget（external 工具的精确去向），null 只匹配 null——无 target 的
// 工具级授权绝不放大成「对任何去向都允许」。时钟注入：match/list 的 now 参数
// 缺省才是 Date.now()（调用边），测试注入同一判据。
// 本模块不注册任何 agent 可调用工具（no-self-revoke），消费方见
// preAskGrant.ts / grantLedger.ts / orchestratorPermissions.ts。

import type BetterSqlite3 from 'better-sqlite3';
import { TOOL_GRANT_TIERS } from '../../shared/constants/timeouts';

export type ToolGrantTier = 'run' | '24h';

export interface ToolGrantListItem {
  tier: ToolGrantTier;
  tool: string;
  /** external 工具的精确去向；无 target 的授权为 null */
  target: string | null;
  /** run 档：授权所属会话；24h 档：null */
  sessionId: string | null;
  grantedAt: number;
  /** run 档 = null（随 run 结束，无固定时刻）；24h 档 = 到期时刻 */
  expiresAt: number | null;
}

interface GrantRow {
  tool_key: string;
  tool_name: string;
  target: string | null;
  granted_at: number;
  expires_at: number;
}

/** run 档内存行的存键；与 24h 档的 tool_key 同构。 */
function toolKey(tool: string, target: string | null): string {
  return target ? `${tool}\u0000${target}` : tool;
}

class ToolGrantRepository {
  private readonly upsertStmt: BetterSqlite3.Statement;
  private readonly deleteStmt: BetterSqlite3.Statement;
  private readonly listStmt: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database) {
    this.upsertStmt = db.prepare(`
      INSERT INTO tool_permission_grants (tool_key, tool_name, target, granted_at, expires_at)
      VALUES (@toolKey, @tool, @target, @grantedAt, @expiresAt)
      ON CONFLICT(tool_key) DO UPDATE SET
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at
    `);
    this.deleteStmt = db.prepare('DELETE FROM tool_permission_grants WHERE tool_key = ?');
    this.listStmt = db.prepare(
      'SELECT tool_key, tool_name, target, granted_at, expires_at FROM tool_permission_grants ORDER BY granted_at ASC',
    );
  }

  upsert(tool: string, target: string | null, grantedAt: number, expiresAt: number): void {
    this.upsertStmt.run({ toolKey: toolKey(tool, target), tool, target, grantedAt, expiresAt });
  }

  delete(tool: string, target: string | null): boolean {
    return this.deleteStmt.run(toolKey(tool, target)).changes > 0;
  }

  list(): GrantRow[] {
    return this.listStmt.all() as GrantRow[];
  }
}

function isExpired(expiresAt: number | null | undefined, now: number): boolean {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && now >= expiresAt;
}

class ToolGrantStore {
  /** sessionId → (toolKey → 批准时刻)。run 档全部状态，进程内。 */
  private readonly runs = new Map<string, Map<string, number>>();

  constructor(private readonly repo: ToolGrantRepository | null) {}

  mintRun(sessionId: string, tool: string, target: string | null, grantedAt: number): void {
    if (!sessionId) return;
    let bucket = this.runs.get(sessionId);
    if (!bucket) {
      bucket = new Map();
      this.runs.set(sessionId, bucket);
    }
    bucket.set(toolKey(tool, target), grantedAt);
  }

  mint24h(tool: string, target: string | null, grantedAt: number): void {
    this.repo?.upsert(tool, target, grantedAt, grantedAt + TOOL_GRANT_TIERS.TIER_24H_MS);
  }

  /** run 档优先（更窄）；两档 target 都要求精确一致（null 只匹配 null）。 */
  match(sessionId: string | null | undefined, tool: string, target: string | null, now: number): ToolGrantTier | null {
    const key = toolKey(tool, target);
    if (sessionId && this.runs.get(sessionId)?.has(key)) return 'run';
    const hit = this.repo?.list().some(
      (row) => row.tool_key === key && !isExpired(row.expires_at, now),
    );
    return hit ? '24h' : null;
  }

  /** 台账消费：run 档全列（活在本进程 = 本轮任务里）；24h 档未过期的才列。 */
  list(now: number): ToolGrantListItem[] {
    const items: ToolGrantListItem[] = [];
    for (const [sessionId, bucket] of this.runs) {
      for (const [key, grantedAt] of bucket) {
        const { tool, target } = splitToolKey(key);
        items.push({ tier: 'run', tool, target, sessionId, grantedAt, expiresAt: null });
      }
    }
    for (const row of this.repo?.list() ?? []) {
      if (isExpired(row.expires_at, now)) continue;
      items.push({
        tier: '24h',
        tool: row.tool_name,
        target: row.target,
        sessionId: null,
        grantedAt: row.granted_at,
        expiresAt: row.expires_at,
      });
    }
    return items;
  }

  revokeRun(sessionId: string, tool: string, target: string | null): boolean {
    return this.runs.get(sessionId)?.delete(toolKey(tool, target)) ?? false;
  }

  revoke24h(tool: string, target: string | null): boolean {
    return this.repo?.delete(tool, target) ?? false;
  }

  /** run 结束点（runFinalizer）：该会话的 run 档整清——下一轮任务重新询问。 */
  clearRuns(sessionId: string): number {
    const cleared = this.runs.get(sessionId)?.size ?? 0;
    this.runs.delete(sessionId);
    return cleared;
  }
}

function splitToolKey(key: string): { tool: string; target: string | null } {
  const separator = key.indexOf('\u0000');
  if (separator === -1) return { tool: key, target: null };
  return { tool: key.slice(0, separator), target: key.slice(separator + 1) };
}

let store: ToolGrantStore | null = null;
let boundDb: BetterSqlite3.Database | null = null;

export function bindToolGrantDatabase(db: BetterSqlite3.Database | null, fresh = false): void {
  if (!fresh && store && boundDb === db) return;
  boundDb = db;
  // db=null → 只剩 run 档内存桶（24h 档不可持久化也不可匹配，fail-safe）。
  store = new ToolGrantStore(db ? new ToolGrantRepository(db) : null);
}

function currentStore(): ToolGrantStore {
  if (!store) {
    try {
      // 懒取：静态 import databaseService 会在建表链路里转回来。
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getDatabase } = require('../services/core/databaseService') as typeof import('../services/core/databaseService');
      const db = getDatabase().getDb();
      bindToolGrantDatabase(db ?? null);
    } catch {
      bindToolGrantDatabase(null);
    }
  }
  return store!;
}

export function mintToolRunGrant(sessionId: string, tool: string, target: string | null = null, grantedAt: number = Date.now()): void {
  currentStore().mintRun(sessionId, tool, target, grantedAt);
}

export function mintTool24hGrant(tool: string, target: string | null = null, grantedAt: number = Date.now()): void {
  currentStore().mint24h(tool, target, grantedAt);
}

/** 命中返回档位（ledgerReason 用 tool_grant:<tier>）；不命中 null。 */
export function matchToolGrant(
  sessionId: string | null | undefined,
  tool: string,
  target: string | null = null,
  now: number = Date.now(),
): ToolGrantTier | null {
  return currentStore().match(sessionId, tool, target, now);
}

export function listToolGrants(now: number = Date.now()): ToolGrantListItem[] {
  return currentStore().list(now);
}

export function revokeToolRunGrant(sessionId: string, tool: string, target: string | null = null): boolean {
  return currentStore().revokeRun(sessionId, tool, target);
}

export function revokeTool24hGrant(tool: string, target: string | null = null): boolean {
  return currentStore().revoke24h(tool, target);
}

/** run 结束清 run 档（runFinalizer 唯一调用点）。 */
export function clearToolRunGrants(sessionId: string): void {
  currentStore().clearRuns(sessionId);
}
