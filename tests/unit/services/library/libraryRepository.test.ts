import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { LibraryRepository } from '../../../../src/host/services/core/repositories/LibraryRepository';
import type { LibraryItem } from '../../../../src/shared/contract/library';

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: `lib_${Math.random().toString(36).slice(2)}`,
    projectId: null,
    title: 'Brief.pdf',
    kind: 'upload',
    pathOrUri: '/tmp/library/Brief.pdf',
    tags: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('LibraryRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: LibraryRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger() as never);
    repo = new LibraryRepository(db);
  });

  it('创建后可按 id 读回，字段完整往返', () => {
    const item = makeItem({
      projectId: 'proj_1',
      tags: ['素材', '证据'],
      summary: '竞品对比表',
      sourceSessionId: 'sess_1',
      sourceRoleId: 'role_1',
      contentHash: 'abc123',
    });
    repo.createItem(item);

    const loaded = repo.getItem(item.id);
    expect(loaded).toEqual(item);
  });

  it('listItems 按 projectId 过滤：undefined=全部，null=仅全局架', () => {
    repo.createItem(makeItem({ id: 'a', projectId: 'proj_1' }));
    repo.createItem(makeItem({ id: 'b', projectId: null }));

    expect(repo.listItems().map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(repo.listItems({ projectId: 'proj_1' }).map((i) => i.id)).toEqual(['a']);
    expect(repo.listItems({ projectId: null }).map((i) => i.id)).toEqual(['b']);
  });

  it('listItems 支持 kind 与 tag 过滤', () => {
    repo.createItem(makeItem({ id: 'a', kind: 'upload', tags: ['定稿'] }));
    repo.createItem(makeItem({ id: 'b', kind: 'artifact', tags: ['草稿'] }));

    expect(repo.listItems({ kind: 'artifact' }).map((i) => i.id)).toEqual(['b']);
    expect(repo.listItems({ tag: '定稿' }).map((i) => i.id)).toEqual(['a']);
  });

  it('updateItem 局部更新并写入 updatedAt；空 patch 返回 false', () => {
    repo.createItem(makeItem({ id: 'a', title: 'old', tags: ['素材'] }));

    expect(repo.updateItem('a', {}, 2000)).toBe(false);
    expect(repo.updateItem('a', { title: 'new', tags: ['定稿'] }, 2000)).toBe(true);

    const loaded = repo.getItem('a');
    expect(loaded?.title).toBe('new');
    expect(loaded?.tags).toEqual(['定稿']);
    expect(loaded?.updatedAt).toBe(2000);
    expect(loaded?.createdAt).toBe(1000);
  });

  it('findByContentHash 区分项目作用域', () => {
    repo.createItem(makeItem({ id: 'a', projectId: 'proj_1', contentHash: 'h1' }));

    expect(repo.findByContentHash('proj_1', 'h1')?.id).toBe('a');
    expect(repo.findByContentHash(null, 'h1')).toBeUndefined();
    expect(repo.findByContentHash('proj_2', 'h1')).toBeUndefined();
  });

  it('deleteItem 删除后不可读回', () => {
    repo.createItem(makeItem({ id: 'a' }));
    expect(repo.deleteItem('a')).toBe(true);
    expect(repo.getItem('a')).toBeUndefined();
    expect(repo.deleteItem('a')).toBe(false);
  });

  it('listItemsByIds 保持传入顺序并剔除缺失 id', () => {
    repo.createItem(makeItem({ id: 'a' }));
    repo.createItem(makeItem({ id: 'b' }));

    expect(repo.listItemsByIds(['b', 'missing', 'a']).map((i) => i.id)).toEqual(['b', 'a']);
    expect(repo.listItemsByIds([])).toEqual([]);
  });

  it('pin upsert 往返 + 覆盖更新 + 删除', () => {
    expect(repo.getPin('sess_1')).toBeUndefined();

    repo.setPin({ sessionId: 'sess_1', itemIds: ['a', 'b'], addedAt: 1000 });
    expect(repo.getPin('sess_1')).toEqual({ sessionId: 'sess_1', itemIds: ['a', 'b'], addedAt: 1000 });

    repo.setPin({ sessionId: 'sess_1', itemIds: ['c'], addedAt: 2000 });
    expect(repo.getPin('sess_1')).toEqual({ sessionId: 'sess_1', itemIds: ['c'], addedAt: 2000 });

    expect(repo.deletePin('sess_1')).toBe(true);
    expect(repo.getPin('sess_1')).toBeUndefined();
  });

  it('损坏的 tags JSON 解析为安全空数组', () => {
    repo.createItem(makeItem({ id: 'a' }));
    db.prepare("UPDATE library_items SET tags = 'not-json' WHERE id = 'a'").run();
    expect(repo.getItem('a')?.tags).toEqual([]);
  });
});
