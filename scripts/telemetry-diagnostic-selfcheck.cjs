#!/usr/bin/env node
// ============================================================================
// telemetry-diagnostic-selfcheck — 诊断包上传整链路一次性自检
// ============================================================================
// 思路:往本地排队表插一条探针 bundle(synced_at=NULL)。app 运行 + 已登录时,
// uploader 每 ~5min 跑一次,推送成功后会把 synced_at 置位。所以:
//   - insert:插探针 → 记下 id
//   - check :读探针的 synced_at;非空 = 云端接受了这一行(整链路通)
//   - clean :清掉探针
// 无需查云表、无需 DB 密码,synced_at 翻位即证明 client→cloud 链路工作。
//
// 用法:
//   node scripts/telemetry-diagnostic-selfcheck.cjs insert
//   node scripts/telemetry-diagnostic-selfcheck.cjs check
//   node scripts/telemetry-diagnostic-selfcheck.cjs clean
// ============================================================================

const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'code-agent', 'code-agent.db');
const PROBE_PREFIX = 'selfcheck-';

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`✗ 本地库不存在: ${DB_PATH}\n  先启动一次 app 让它初始化数据库。`);
    process.exit(1);
  }
  return new Database(DB_PATH);
}

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_diagnostic_bundles (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_version TEXT, prompt_version TEXT,
      tool_schema_version TEXT, trigger_reason TEXT NOT NULL, bundle_version INTEGER NOT NULL DEFAULT 1,
      built_at INTEGER NOT NULL, bundle TEXT NOT NULL, created_at INTEGER NOT NULL, synced_at INTEGER
    );
  `);
}

function insert(db) {
  ensureTable(db);
  const now = Date.now();
  const id = `${PROBE_PREFIX}${now}`;
  const bundle = JSON.stringify({ selfcheck: true, note: 'telemetry diagnostic upload self-check probe', at: now });
  db.prepare(`
    INSERT INTO telemetry_diagnostic_bundles
      (id, session_id, agent_version, prompt_version, tool_schema_version, trigger_reason, bundle_version, built_at, bundle, created_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(id, `selfcheck-session-${now}`, 'selfcheck', 'sys-selfcheck', 'tools-selfcheck', 'manual', 1, now, bundle, now);
  console.log(`✓ 已插入探针 bundle: ${id}`);
  console.log(`  确保 app 正在运行且已登录,等一个 uploader 周期(~5min),然后:`);
  console.log(`    node scripts/telemetry-diagnostic-selfcheck.cjs check`);
}

function check(db) {
  const rows = db.prepare(
    `SELECT id, created_at, synced_at FROM telemetry_diagnostic_bundles WHERE id LIKE ? ORDER BY created_at DESC`,
  ).all(`${PROBE_PREFIX}%`);
  if (rows.length === 0) {
    console.log('（没有探针。先跑 insert）');
    return;
  }
  for (const r of rows) {
    const status = r.synced_at ? `✅ 已上传(synced_at=${new Date(r.synced_at).toISOString()})` : '⏳ 待上传(synced_at=NULL)';
    console.log(`${r.id}  ${status}`);
  }
  const pending = rows.filter((r) => !r.synced_at).length;
  if (pending > 0) {
    console.log(`\n仍有 ${pending} 条待上传。排查:app 是否在跑?是否已登录?Supabase 是否初始化?`);
  } else {
    console.log(`\n✅ 整链路通:client → 本地队列 → uploader → 云端 telemetry_diagnostic_bundles 已接受。`);
  }
}

function clean(db) {
  const info = db.prepare(`DELETE FROM telemetry_diagnostic_bundles WHERE id LIKE ?`).run(`${PROBE_PREFIX}%`);
  console.log(`✓ 已清理 ${info.changes} 条探针。`);
}

const cmd = process.argv[2] || 'insert';
const db = openDb();
try {
  if (cmd === 'insert') insert(db);
  else if (cmd === 'check') check(db);
  else if (cmd === 'clean') clean(db);
  else {
    console.error(`未知命令: ${cmd}（可用: insert | check | clean）`);
    process.exit(1);
  }
} finally {
  db.close();
}
