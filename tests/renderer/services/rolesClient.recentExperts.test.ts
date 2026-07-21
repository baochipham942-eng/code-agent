import { describe, expect, it } from 'vitest';
import { recentExperts } from '../../../src/renderer/services/rolesClient';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';

function entry(roleId: string, overrides: Partial<RolePanelEntry> = {}): RolePanelEntry {
  return { roleId, description: '', source: 'builtin', memoryCount: 0, lastWork: null, ...overrides };
}

describe('recentExperts', () => {
  it('只保留有记录的角色（履历或记忆），无记录不显示', () => {
    const result = recentExperts([
      entry('a'),
      entry('b', { lastWork: '写了周报' }),
      entry('c', { memoryCount: 3 }),
    ]);
    expect(result.map((r) => r.roleId)).toEqual(['b', 'c']);
  });

  it('封顶 5 个', () => {
    const many = Array.from({ length: 8 }, (_, i) => entry(`r${i}`, { memoryCount: 1 }));
    expect(recentExperts(many)).toHaveLength(5);
  });

  it('全部无记录返回空数组（头像条隐藏）', () => {
    expect(recentExperts([entry('a'), entry('b')])).toEqual([]);
  });
});
