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

describe('LibraryService', () => {
  let db: BetterSqlite3.Database;
  let service: LibraryService;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger() as never);
    rawDb = db;
    service = new LibraryService();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-test-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.CODE_AGENT_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saveUpload 落盘到项目目录并登记 upload 条目', () => {
    const item = service.saveUpload({
      projectId: 'proj_1',
      filename: 'Brief.pdf',
      dataBase64: Buffer.from('pdf-bytes').toString('base64'),
      tags: ['素材'],
    }, 1000);

    expect(item.kind).toBe('upload');
    expect(item.projectId).toBe('proj_1');
    expect(item.title).toBe('Brief.pdf');
    expect(item.tags).toEqual(['素材']);
    expect(fs.readFileSync(item.pathOrUri, 'utf8')).toBe('pdf-bytes');
    expect(item.pathOrUri.startsWith(path.join(tmpDir, 'library', 'proj_1'))).toBe(true);
  });

  it('saveUpload 同项目相同内容去重，不重复落盘', () => {
    const data = Buffer.from('same-bytes').toString('base64');
    const first = service.saveUpload({ projectId: null, filename: 'a.txt', dataBase64: data }, 1000);
    const second = service.saveUpload({ projectId: null, filename: 'b.txt', dataBase64: data }, 2000);

    expect(second.id).toBe(first.id);
    expect(fs.readdirSync(path.join(tmpDir, 'library', 'global'))).toHaveLength(1);
  });

  it('saveUpload 文件名只取 basename，路径穿越被拦', () => {
    const item = service.saveUpload({
      filename: '../../etc/passwd',
      dataBase64: Buffer.from('x').toString('base64'),
    }, 1000);

    expect(path.dirname(item.pathOrUri)).toBe(path.join(tmpDir, 'library', 'global'));
    expect(path.basename(item.pathOrUri)).toBe('passwd');
  });

  it('saveUpload 重名文件加内容哈希后缀', () => {
    const a = service.saveUpload({ filename: 'doc.md', dataBase64: Buffer.from('v1').toString('base64') }, 1000);
    const b = service.saveUpload({ filename: 'doc.md', dataBase64: Buffer.from('v2').toString('base64') }, 2000);

    expect(a.pathOrUri).not.toBe(b.pathOrUri);
    expect(fs.readFileSync(b.pathOrUri, 'utf8')).toBe('v2');
  });

  it('saveUpload 空内容拒绝', () => {
    expect(() => service.saveUpload({ filename: 'x.txt', dataBase64: '' }, 1000)).toThrow('empty');
  });

  it('addItem 归档产物：contentHash 命中时返回已有条目', () => {
    const first = service.addItem({
      projectId: 'proj_1',
      title: 'PRD.md',
      kind: 'artifact',
      pathOrUri: '/workspace/PRD.md',
      contentHash: 'h1',
    }, 1000);
    const second = service.addItem({
      projectId: 'proj_1',
      title: 'PRD-copy.md',
      kind: 'artifact',
      pathOrUri: '/workspace/PRD-copy.md',
      contentHash: 'h1',
    }, 2000);

    expect(second.id).toBe(first.id);
  });

  it('delete 只删资料库目录内的 upload 文件，库外文件不动', () => {
    const uploaded = service.saveUpload({ filename: 'in.txt', dataBase64: Buffer.from('x').toString('base64') }, 1000);
    const outside = path.join(tmpDir, 'outside.txt');
    fs.writeFileSync(outside, 'keep');
    const external = service.addItem({ title: 'out', kind: 'artifact', pathOrUri: outside }, 1000);

    expect(service.delete(uploaded.id)).toBe(true);
    expect(fs.existsSync(uploaded.pathOrUri)).toBe(false);

    expect(service.delete(external.id)).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('setPinnedItems 只保留真实存在的条目并去重', () => {
    const a = service.addItem({ title: 'a', kind: 'external_ref', pathOrUri: 'https://a' }, 1000);
    const pin = service.setPinnedItems('sess_1', [a.id, a.id, 'missing'], 2000);

    expect(pin.itemIds).toEqual([a.id]);
    expect(service.getPinnedItems('sess_1').map((i) => i.id)).toEqual([a.id]);
    expect(service.getPin('sess_2')).toEqual({ sessionId: 'sess_2', itemIds: [], addedAt: 0 });
  });
});
