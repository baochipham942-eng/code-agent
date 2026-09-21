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

  function writeSource(name: string, content: string): string {
    const dir = path.join(tmpDir, 'incoming');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it('addItem 忽略非法 learnStatus，改走 kind 默认值', () => {
    const item = service.addItem({
      title: 'a.txt',
      kind: 'upload',
      pathOrUri: path.join(tmpDir, 'a.txt'),
      learnStatus: 'ok' as never,
    }, 1000);
    expect(item.learnStatus).toBe('pending');
    expect(service.get(item.id)?.learnStatus).toBe('pending');
  });

  it('importFile 拷入项目目录并登记 upload 条目，学习完成后可用', async () => {
    const src = writeSource('Brief.txt', 'pdf-bytes');
    const item = await service.importFile({ projectId: 'proj_1', sourcePath: src, tags: ['素材'] }, 1000);

    expect(item.kind).toBe('upload');
    expect(item.projectId).toBe('proj_1');
    expect(item.title).toBe('Brief.txt');
    expect(item.tags).toEqual(['素材']);
    expect(item.learnStatus).toBe('ready');
    expect(fs.readFileSync(item.pathOrUri, 'utf8')).toBe('pdf-bytes');
    expect(item.pathOrUri.startsWith(path.join(tmpDir, 'library', 'proj_1'))).toBe(true);
    // 源文件保留（temp 清理归上传端点管）
    expect(fs.existsSync(src)).toBe(true);
  });

  it('importFile 同项目相同内容去重，不重复落盘', async () => {
    const first = await service.importFile({ projectId: null, sourcePath: writeSource('a.txt', 'same-bytes') }, 1000);
    const second = await service.importFile({ projectId: null, sourcePath: writeSource('b.txt', 'same-bytes') }, 2000);

    expect(second.id).toBe(first.id);
    const names = fs.readdirSync(path.join(tmpDir, 'library', 'global')).filter((name) => name !== '.extracted');
    expect(names).toHaveLength(1);
  });

  it('importFile 重名文件加内容哈希后缀', async () => {
    const a = await service.importFile({ sourcePath: writeSource('doc.md', 'v1') }, 1000);
    fs.rmSync(path.join(tmpDir, 'incoming'), { recursive: true });
    const b = await service.importFile({ sourcePath: writeSource('doc.md', 'v2') }, 2000);

    expect(a.pathOrUri).not.toBe(b.pathOrUri);
    expect(fs.readFileSync(b.pathOrUri, 'utf8')).toBe('v2');
  });

  it('importFile 空文件拒绝，源文件不存在时抛错', async () => {
    await expect(service.importFile({ sourcePath: writeSource('x.txt', '') }, 1000)).rejects.toThrow('empty');
    await expect(service.importFile({ sourcePath: path.join(tmpDir, 'nope.txt') }, 1000)).rejects.toThrow();
  });

  it('addItem 无 contentHash 时按同项目同路径去重（重复归档幂等）', () => {
    const rawPath = path.join(os.homedir(), 'workspace', 'drafts', '..', 'PRD.md');
    const normalizedPath = path.resolve(rawPath);
    const first = service.addItem({ projectId: 'proj_1', title: 'PRD.md', kind: 'artifact', pathOrUri: rawPath }, 1000);
    const again = service.addItem({ projectId: 'proj_1', title: 'PRD-again', kind: 'artifact', pathOrUri: normalizedPath }, 2000);
    const otherProject = service.addItem({ projectId: 'proj_2', title: 'PRD.md', kind: 'artifact', pathOrUri: normalizedPath }, 3000);

    expect(again.id).toBe(first.id);
    expect(otherProject.id).not.toBe(first.id);
    expect(service.get(first.id)?.pathOrUri).toBe(normalizedPath);
    expect(service.list({ projectId: 'proj_1' })).toHaveLength(1);
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

  it('delete 只删资料库目录内的 upload 文件，库外文件不动', async () => {
    const uploaded = await service.importFile({ sourcePath: writeSource('in.txt', 'x') }, 1000);
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

  it('不支持的格式进入 failed，重试仍保留真实原因', async () => {
    const item = await service.importFile({ sourcePath: writeSource('archive.bin', 'bytes') }, 1000);
    expect(item.learnStatus).toBe('failed');
    expect(item.learnError).toContain('不支持抽取文本的格式');
    expect(item.learnError).not.toContain('embedding');

    const retried = await service.retryLearn(item.id, 2000);
    expect(retried.learnStatus).toBe('failed');
    expect(retried.learnError).toBe(item.learnError);
  });

  it('依据投影只在命中 ready 条目时返回片段', async () => {
    const item = await service.importFile({ sourcePath: writeSource('evidence.md', '一行\n二行\n三行\n四行') }, 1000);
    const hit = service.projectEvidence({ source: item.pathOrUri, location: 'line:2' });
    expect(hit.hit).toBe(true);
    expect(hit.item?.id).toBe(item.id);
    expect(hit.fragment?.text).toContain('二行');

    const miss = service.projectEvidence({ source: path.join(tmpDir, 'missing.md'), location: 'line:1' });
    expect(miss.hit).toBe(false);
    expect(miss.fragment).toBeUndefined();

    const outOfRange = service.projectEvidence({ source: item.pathOrUri, location: 'line:99' });
    expect(outOfRange.hit).toBe(false);
    expect(outOfRange.fragment).toBeUndefined();
  });

  it('无抽取器的 artifact 经 sweep 落 ready 而不是 failed', async () => {
    const artifactPath = writeSource('deck.pptx', 'binary');
    const item = service.addItem({
      title: 'deck.pptx',
      kind: 'artifact',
      pathOrUri: artifactPath,
      learnStatus: 'pending',
    }, 1000);
    expect(item.learnStatus).toBe('pending');
    await expect(service.sweepPendingLearn(2000)).resolves.toBe(1);
    expect(service.get(item.id)?.learnStatus).toBe('ready');
    expect(service.get(item.id)?.learnError).toBeUndefined();
  });

  it('可抽取的 artifact 不得假装 ready：先 pending，sweep 后才有 sidecar', async () => {
    const artifactPath = writeSource('notes.md', '归档正文');
    const item = service.addItem({
      title: 'notes.md',
      kind: 'artifact',
      pathOrUri: artifactPath,
    }, 1000);
    expect(item.learnStatus).toBe('pending');
    expect(service.projectEvidence({ source: artifactPath, location: 'line:1' }).hit).toBe(false);

    await expect(service.sweepPendingLearn(2000)).resolves.toBe(1);
    const learned = service.get(item.id);
    expect(learned?.learnStatus).toBe('ready');
    expect(service.projectEvidence({ source: artifactPath, location: 'line:1' }).hit).toBe(true);
  });

  it('retryLearn 能接手卡在 running 的条目', async () => {
    const item = service.addItem({
      title: 'stuck.md',
      kind: 'upload',
      pathOrUri: writeSource('stuck.md', '正文'),
      learnStatus: 'pending',
    }, 1000);
    db.prepare("UPDATE library_items SET learn_status = 'running', learn_updated_at = 1000 WHERE id = ?").run(item.id);
    expect(service.get(item.id)?.learnStatus).toBe('running');
    const retried = await service.retryLearn(item.id, 2000);
    expect(retried.learnStatus).toBe('ready');
  });

  it('迁移后的 capture/external_ref pending 可由 sweep 合法变为 ready', async () => {
    const item = service.addItem({
      title: '网页摘录',
      kind: 'capture',
      pathOrUri: 'https://example.com/note',
      learnStatus: 'pending',
    }, 1000);
    expect(item.learnStatus).toBe('pending');
    await expect(service.sweepPendingLearn(2000)).resolves.toBe(1);
    expect(service.get(item.id)?.learnStatus).toBe('ready');
  });

  it('.xls 明确不支持抽取，不得假装可学习', async () => {
    const item = await service.importFile({ sourcePath: writeSource('old.xls', 'not-ooxml') }, 1000);
    expect(item.learnStatus).toBe('failed');
    expect(item.learnError).toContain('.xls');
  });

  it('update projectId 把 sidecar 迁到新项目目录', async () => {
    const item = await service.importFile({
      projectId: 'proj_1',
      sourcePath: writeSource('note.md', '依据正文'),
    }, 1000);
    const moved = service.update(item.id, { projectId: 'proj_2' }, 2000);
    expect(moved?.projectId).toBe('proj_2');
    expect(service.projectEvidence({ source: item.pathOrUri, location: 'line:1' }).hit).toBe(true);
    const oldSidecar = path.join(tmpDir, 'library', 'proj_1', '.extracted', `${item.id}.md`);
    const newSidecar = path.join(tmpDir, 'library', 'proj_2', '.extracted', `${item.id}.md`);
    expect(fs.existsSync(oldSidecar)).toBe(false);
    expect(fs.existsSync(newSidecar)).toBe(true);
  });
});
