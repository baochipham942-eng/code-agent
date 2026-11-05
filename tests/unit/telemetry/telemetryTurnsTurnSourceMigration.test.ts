// ============================================================================
// telemetry_turns 云端迁移契约：turn_source 补列 + 上传行 ↔ 云端列漂移守卫
// ============================================================================
// 背景：客户端上传行（telemetryUploadRow.ts）已带 turn_source（委托来源标记），
// 但云端 telemetry_turns 建表时没有这一列，每轮 turn 上传都被 PGRST204 整批拒绝。
// 这里钉两件事：
//   1) 补列迁移幂等、nullable、并刷新 PostgREST schema cache；
//   2) 上传行的每一个 key 都必须能在 supabase/migrations 里找到对应列——
//      row 加列而云端迁移没跟上的事，测试期就红，不留到线上启动日志里才发现。

import { readdirSync, readFileSync } from 'node:fs';
import os from 'os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTelemetryPreviewTurn,
  buildTelemetryTurnUploadRow,
} from '../../../src/host/telemetry/telemetryUploadRow';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const turnSourceMigrationPath = path.join(migrationsDir, '20261104000000_telemetry_turns_turn_source.sql');

describe('telemetry_turns turn_source cloud migration contract', () => {
  it('adds turn_source as an idempotent nullable column and reloads the PostgREST schema cache', () => {
    const sql = readFileSync(turnSourceMigrationPath, 'utf8');
    expect(sql).toContain('ALTER TABLE public.telemetry_turns ADD COLUMN IF NOT EXISTS turn_source TEXT;');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });
});

describe('turn upload row vs cloud migrations drift guard', () => {
  /** telemetry_turns 的全部已知云端列：建表定义列 + 历次 ADD COLUMN，跨全部迁移文件。 */
  function knownTelemetryTurnColumns(): Set<string> {
    const columns = new Set<string>();
    for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))) {
      const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
      // 建表定义列（注意 public\. 前缀：tests/ 的 DDL 漂移守卫按无前缀形态扫描，
      // 这里只解析带 schema 前缀的真源形态，不构成手抄 DDL）。
      const createBody = /CREATE TABLE IF NOT EXISTS public\.telemetry_turns \(([\s\S]*?)\n\);/u.exec(sql)?.[1];
      if (createBody) {
        for (const line of createBody.split('\n')) {
          const column = /^ {2}([a-z_]+)\s/u.exec(line)?.[1];
          if (column) columns.add(column);
        }
      }
      for (const match of sql.matchAll(/ALTER TABLE public\.telemetry_turns\s+ADD COLUMN (?:IF NOT EXISTS )?([a-z_]+)/gu)) {
        const column = match[1];
        if (column) columns.add(column);
      }
    }
    return columns;
  }

  it('every key of the turn upload row is a cloud column (create-table or ADD COLUMN)', () => {
    const homeDir = os.homedir();
    const row = buildTelemetryTurnUploadRow(
      buildTelemetryPreviewTurn(homeDir),
      'preview-session',
      'preview-user',
      homeDir,
    );
    const columns = knownTelemetryTurnColumns();
    expect(columns.size).toBeGreaterThan(0);
    const missing = Object.keys(row).filter((key) => !columns.has(key));
    expect(missing, '上传行有、云端迁移没有的列（row ↔ migration 漂移）').toEqual([]);
  });
});
