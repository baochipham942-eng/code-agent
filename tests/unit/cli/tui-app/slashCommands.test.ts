// ============================================================================
// tui-app/slashCommands.ts — slash 补全过滤 单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  buildSlashItems,
  filterSlashCommands,
  LOCAL_SLASH_ITEMS,
} from '../../../../src/cli/tui-app/slashCommands';

const REGISTRY = [
  { id: 'cost', name: 'cost', description: 'token 用量与成本' },
  { id: 'context', name: 'context', description: '上下文窗口用量' },
  { id: 'permissions', name: 'permissions', description: '权限状态' },
];

describe('buildSlashItems', () => {
  it('注册表命令 + 本地命令合并去重', () => {
    const items = buildSlashItems(REGISTRY);
    const names = items.map((i) => i.name);
    expect(names).toContain('cost');
    expect(names).toContain('context');
    expect(names).toContain('exit');
    expect(names).toContain('model');
    // 无重复
    expect(new Set(names).size).toBe(names.length);
  });

  it('注册表与本地同名时注册表优先', () => {
    const items = buildSlashItems([{ id: 'x', name: 'exit', description: 'registry exit' }]);
    const exit = items.find((i) => i.name === 'exit');
    expect(exit?.description).toBe('registry exit');
  });
});

describe('filterSlashCommands', () => {
  const items = buildSlashItems(REGISTRY);

  it('空查询返回全部', () => {
    expect(filterSlashCommands('', items)).toHaveLength(items.length);
  });

  it('前缀命中排前，子串命中排后', () => {
    const filtered = filterSlashCommands('co', items);
    expect(filtered.length).toBeGreaterThan(1);
    // 前缀命中（cost/context/compact/config）应排在子串命中之前
    const firstSubstringIdx = filtered.findIndex(
      (i) => !i.name.toLowerCase().startsWith('co'),
    );
    if (firstSubstringIdx > 0) {
      for (let i = 0; i < firstSubstringIdx; i++) {
        expect(filtered[i].name.toLowerCase().startsWith('co')).toBe(true);
      }
    }
    expect(filtered[0].name.toLowerCase().startsWith('co')).toBe(true);
  });

  it('大小写不敏感', () => {
    const filtered = filterSlashCommands('EXI', items);
    expect(filtered.some((i) => i.name === 'exit')).toBe(true);
  });

  it('无命中返回空', () => {
    expect(filterSlashCommands('zzzzz', items)).toHaveLength(0);
  });

  it('本地命令全量在册', () => {
    const names = items.map((i) => i.name);
    for (const local of LOCAL_SLASH_ITEMS) {
      expect(names).toContain(local.name);
    }
  });
});
