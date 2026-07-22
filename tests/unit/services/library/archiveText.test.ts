import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { applySchema } from '../../../../src/host/services/core/database/schema';

let rawDb: BetterSqlite3.Database;

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => rawDb }),
}));

import { LibraryService } from '../../../../src/host/services/library/libraryService';

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('LibraryService.archiveText', () => {
  let db: BetterSqlite3.Database;
  let service: LibraryService;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger() as never);
    rawDb = db;
    service = new LibraryService();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-archive-text-test-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.CODE_AGENT_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    db.close();
  });

  it('归档文本为 artifact 条目并写入资料库文件', () => {
    const text = '这是 cron agent 的最终产出。';
    const item = service.archiveText({
      projectId: 'proj_1',
      title: '日报 / 定稿',
      text,
      tags: ['定稿'],
      sourceSessionId: 'cron_session_1',
      sourceRoleId: 'role_1',
    }, 1000);

    expect(item.kind).toBe('artifact');
    expect(item.projectId).toBe('proj_1');
    expect(item.tags).toContain('定稿');
    expect(item.pathOrUri).toMatch(/日报 _ 定稿-[a-f0-9]{8}\.md$/);
    expect(fs.readFileSync(item.pathOrUri, 'utf8')).toBe(text);
    expect(item.sourceSessionId).toBe('cron_session_1');
    expect(item.sourceRoleId).toBe('role_1');
  });

  it('同项目同文本按 contentHash 幂等，不产生第二个文件或条目', () => {
    const first = service.archiveText({ projectId: 'proj_1', title: '第一次', text: 'same output' }, 1000);
    const second = service.archiveText({ projectId: 'proj_1', title: '第二次', text: 'same output' }, 2000);

    expect(second.id).toBe(first.id);
    expect(fs.readdirSync(path.join(tmpDir, 'library', 'proj_1'))).toHaveLength(1);
    expect(service.list({ projectId: 'proj_1' })).toHaveLength(1);
  });

  it("projectId='global' 归一到全局资料库", () => {
    const globalItem = service.archiveText({ projectId: 'global', title: '全局', text: 'global output' }, 1000);
    const nullItem = service.archiveText({ projectId: null, title: '全局副本', text: 'global output' }, 2000);

    expect(globalItem.projectId).toBeNull();
    expect(nullItem.id).toBe(globalItem.id);
    expect(globalItem.pathOrUri.startsWith(path.join(tmpDir, 'library', 'global'))).toBe(true);
  });
});
