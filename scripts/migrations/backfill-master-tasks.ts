// ============================================================================
// backfill-master-tasks — 老 session 反向建 MasterTask (P3-c2)
// ============================================================================
//
// 一次性 migration：扫 sessions WHERE master_task_id IS NULL AND is_deleted = 0,
// 为每个未绑定的 session 建一个 MasterTask 行并把 master_task_id 写回 sessions.
//
// API 设计：backfillMasterTasks 接收 db instance（DI），不管理 db 生命周期。
// CLI 入口在底部自己创建 db（require 而非 import default，避开 vitest SSR
// 转换 .default 时 native 模块无 default export 的兼容问题）。
//
// 安全性：
//   - --dry-run: 只统计候选数量，不写 DB（readonly 打开 + 跳过 INSERT/UPDATE）
//   - 写入 transaction 包起来，任一行失败整体 rollback
//   - 幂等：再跑只处理新增的 NULL master_task_id 行
//
// 字段映射：
//   - master_tasks.title         ← sessions.title (空时 fallback `Session <id-prefix>`)
//   - master_tasks.status        ← 固定 'completed' (历史 session 视为已完成)
//   - master_tasks.workspace_uri ← sessions.working_directory (NULL → '')
//   - master_tasks.owner_user_id ← 'local'
//   - master_tasks.created_at    ← sessions.created_at
//   - master_tasks.updated_at    ← sessions.updated_at
//   - master_tasks.finished_at   ← sessions.updated_at
//   - master_tasks.id            ← `mt-backfill-<uuid>`
//
// 用法：
//   npx tsx scripts/migrations/backfill-master-tasks.ts --dry-run
//   npx tsx scripts/migrations/backfill-master-tasks.ts          # 实际执行
//   CODE_AGENT_DATA_DIR=/tmp/test npx tsx scripts/migrations/backfill-master-tasks.ts -v
// ============================================================================

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';

export interface BackfillOptions {
  dryRun: boolean;
  verbose: boolean;
}

export interface BackfillResult {
  totalCandidates: number;
  created: number;
  skipped: number;
}

interface SessionRow {
  id: string;
  title: string | null;
  working_directory: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 跑 backfill。接收 db instance（调用方负责 open/close）。
 * dryRun=true 时不写任何 DB（即使 db 是 readwrite 模式也跳过写入）。
 */
export function backfillMasterTasks(
  db: BetterSqlite3.Database,
  opts: BackfillOptions,
): BackfillResult {
  const rows = db
    .prepare(
      `SELECT id, title, working_directory, created_at, updated_at
         FROM sessions
        WHERE master_task_id IS NULL AND is_deleted = 0
        ORDER BY created_at ASC`,
    )
    .all() as SessionRow[];

  if (rows.length === 0) {
    return { totalCandidates: 0, created: 0, skipped: 0 };
  }

  if (opts.dryRun) {
    if (opts.verbose) {
      for (const row of rows) {
        console.log(`  [dry-run] ${row.id} → ${row.title?.slice(0, 50) ?? '(no title)'}`);
      }
    }
    return { totalCandidates: rows.length, created: rows.length, skipped: 0 };
  }

  // EXECUTE: transaction
  const insertMaster = db.prepare(
    `INSERT INTO master_tasks (
      id, title, status, workspace_uri, plan_progress,
      sandbox_id, parent_task_id, owner_user_id,
      blocks_json, blocked_by_json, metadata_json,
      created_at, updated_at, finished_at, is_deleted
    ) VALUES (?, ?, 'completed', ?, '', NULL, NULL, 'local', '[]', '[]', '{}', ?, ?, ?, 0)`,
  );
  const updateSession = db.prepare(
    `UPDATE sessions SET master_task_id = ? WHERE id = ? AND master_task_id IS NULL`,
  );

  let created = 0;
  let skipped = 0;

  const backfillTx = db.transaction((sessions: SessionRow[]): void => {
    for (const session of sessions) {
      const masterTaskId = `mt-backfill-${randomUUID()}`;
      const titleTrimmed = session.title?.trim() ?? '';
      const title = titleTrimmed.length > 0
        ? titleTrimmed
        : `Session ${session.id.slice(0, 8)}`;
      const workspaceUri = session.working_directory ?? '';

      insertMaster.run(
        masterTaskId,
        title,
        workspaceUri,
        session.created_at,
        session.updated_at,
        session.updated_at,
      );
      const result = updateSession.run(masterTaskId, session.id);
      if (result.changes === 1) {
        created++;
        if (opts.verbose) {
          console.log(`  ✓ ${session.id} → ${masterTaskId}`);
        }
      } else {
        skipped++;
      }
    }
  });

  backfillTx(rows);

  return { totalCandidates: rows.length, created, skipped };
}

export function resolveDbPath(): string {
  const dataDir = process.env.CODE_AGENT_DATA_DIR ?? join(homedir(), '.code-agent');
  return join(dataDir, 'code-agent.db');
}

// ----------------------------------------------------------------------------
// CLI 入口
// ----------------------------------------------------------------------------

const isMainModule =
  typeof process !== 'undefined' &&
  typeof process.argv?.[1] === 'string' &&
  process.argv[1].endsWith('backfill-master-tasks.ts');

if (isMainModule) {
  const argv = process.argv.slice(2);
  const opts: BackfillOptions = {
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
  };
  const dbPath = resolveDbPath();

  console.log(`→ Database: ${dbPath}`);
  console.log(`→ Mode: ${opts.dryRun ? 'DRY-RUN (readonly)' : 'EXECUTE'}`);

  if (!existsSync(dbPath)) {
    console.error(`✗ Database not found. Run code-agent once to initialize schema.`);
    process.exit(1);
  }

  // CLI 用 require（避开 ESM/SSR transform 的 native 模块 default 兼容问题）
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const Database = require('better-sqlite3') as any;
  const db: BetterSqlite3.Database = new Database(dbPath, { readonly: opts.dryRun });

  try {
    const result = backfillMasterTasks(db, opts);
    console.log(
      `\n✓ Total candidates: ${result.totalCandidates}, Created: ${result.created}, Skipped: ${result.skipped}`,
    );
    if (opts.dryRun) {
      console.log(`\nRun without --dry-run to apply.`);
    }
  } catch (err) {
    console.error(`\n✗ Backfill failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
