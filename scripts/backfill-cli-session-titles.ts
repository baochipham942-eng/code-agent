/**
 * 把仍是占位标题的 CLI 会话改成首条可见用户消息的降级标题。
 * 不调模型、不联网、不在应用启动时运行。默认只计数，--apply 才写。
 *
 * 用法：npx tsx scripts/backfill-cli-session-titles.ts <db-path> [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { backfillCliPlaceholderSessionTitles } from '../src/host/telemetry/telemetrySessionTitleBackfill';

function usage(): never {
  console.error('用法：npx tsx scripts/backfill-cli-session-titles.ts <db-path> [--apply]');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const paths = args.filter((arg) => arg !== '--apply');
if (paths.length !== 1) usage();

const dbPath = paths[0];
if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
  console.error(`数据库文件不存在：${dbPath}`);
  process.exit(1);
}

const db = new Database(path.resolve(dbPath), { fileMustExist: true, readonly: !apply });
try {
  const count = backfillCliPlaceholderSessionTitles(db, { apply });
  console.log(apply ? `updated ${count}` : `would update ${count}`);
} finally {
  db.close();
}
