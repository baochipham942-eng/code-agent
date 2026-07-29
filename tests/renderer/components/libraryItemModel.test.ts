// ============================================================================
// libraryItemModel.test.ts - 资料库搜索 / pin 候选口径 / 选择剪枝（任务 9a/16b）
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '@shared/contract/library';
import {
  filterPinCandidates,
  groupPinCandidates,
  matchesLibraryItemSearch,
  pruneLibrarySelection,
} from '../../../src/renderer/components/features/knowledge/libraryItemModel';

function makeItem(partial: Partial<LibraryItem> & { id: string }): LibraryItem {
  return {
    projectId: null,
    title: partial.id,
    kind: 'upload',
    pathOrUri: `/tmp/${partial.id}.md`,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe('matchesLibraryItemSearch', () => {
  const item = makeItem({ id: 'a', title: '季度复盘', summary: 'Q2 review', tags: ['草稿'], pathOrUri: '/x/review.md' });

  it('空查询命中全部', () => {
    expect(matchesLibraryItemSearch(item, '')).toBe(true);
  });

  it('标题 / 摘要 / 标签 / 路径任一命中即匹配（大小写不敏感）', () => {
    expect(matchesLibraryItemSearch(item, '季度')).toBe(true);
    expect(matchesLibraryItemSearch(item, 'q2')).toBe(true);
    expect(matchesLibraryItemSearch(item, '草稿')).toBe(true);
    expect(matchesLibraryItemSearch(item, 'REVIEW.MD')).toBe(true);
    expect(matchesLibraryItemSearch(item, '不存在')).toBe(false);
  });
});

describe('filterPinCandidates（口径契约：当前项目 ∪ 全局架）', () => {
  const mine = makeItem({ id: 'mine', projectId: 'p1' });
  const globalItem = makeItem({ id: 'global', projectId: null });
  const other = makeItem({ id: 'other', projectId: 'p2' });
  const all = [mine, globalItem, other];

  it('只保留当前项目 + 全局架，其他项目不进候选', () => {
    expect(filterPinCandidates(all, 'p1').map((i) => i.id)).toEqual(['mine', 'global']);
  });

  it('无项目会话只剩全局架', () => {
    expect(filterPinCandidates(all, null).map((i) => i.id)).toEqual(['global']);
  });
});

describe('groupPinCandidates', () => {
  it('按归属分组：本项目在前、全局架在后', () => {
    const grouped = groupPinCandidates([
      makeItem({ id: 'g', projectId: null }),
      makeItem({ id: 'p', projectId: 'p1' }),
    ]);
    expect(grouped.project.map((i) => i.id)).toEqual(['p']);
    expect(grouped.global.map((i) => i.id)).toEqual(['g']);
  });
});

describe('pruneLibrarySelection', () => {
  it('剪掉列表里已不存在的选中 id', () => {
    const next = pruneLibrarySelection(new Set(['a', 'gone']), [makeItem({ id: 'a' })]);
    expect([...next]).toEqual(['a']);
  });

  it('无需剪枝时返回原引用（不触发多余渲染）', () => {
    const selected = new Set(['a']);
    expect(pruneLibrarySelection(selected, [makeItem({ id: 'a' })])).toBe(selected);
  });
});
