// ============================================================================
// SlashCommandPopover i18n 键完整性测试
// 文件级 i18n 搬迁的兜底：机械改动量大，用数据层断言防漏键/空文案/zh-en 漂移
// （zh/en 对齐断言写法参照 GoalConfirmCard.test.tsx）
// ============================================================================

import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

type Tree = Record<string, unknown>;

function collectKeyPaths(node: Tree, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      paths.push(...collectKeyPaths(value as Tree, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

function collectLeaves(node: Tree, prefix = ''): Array<[string, unknown]> {
  const leaves: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      leaves.push(...collectLeaves(value as Tree, path));
    } else {
      leaves.push([path, value]);
    }
  }
  return leaves;
}

describe('SlashCommandPopover i18n（slashCommands 键组）', () => {
  it('zh/en 键路径集合完全相等（Translations 类型推导的运行时兜底断言）', () => {
    expect(zh.slashCommands).toBeDefined();
    expect(en.slashCommands).toBeDefined();
    expect(collectKeyPaths(en.slashCommands as unknown as Tree).sort())
      .toEqual(collectKeyPaths(zh.slashCommands as unknown as Tree).sort());
  });

  it('zh/en 每个叶子键都是非空字符串（无漏译/空文案）', () => {
    for (const lang of [zh, en]) {
      for (const [path, value] of collectLeaves(lang.slashCommands as unknown as Tree)) {
        expect(typeof value, `${path} 应为 string`).toBe('string');
        expect((value as string).trim().length, `${path} 不应为空`).toBeGreaterThan(0);
      }
    }
  });

  it('每个命令条目都有 description 和 label（或动态 labelShow/labelHide 对）', () => {
    const entries = zh.slashCommands as unknown as Tree;
    const auxiliaryGroups = new Set(['badges', 'picker']); // 渲染层徽标/装饰文案，不是命令条目
    for (const [id, value] of Object.entries(entries)) {
      if (auxiliaryGroups.has(id)) continue;
      const item = value as Record<string, string>;
      expect(item.description, `${id}.description 缺失`).toBeTruthy();
      const hasStaticLabel = Boolean(item.label);
      const hasToggleLabel = Boolean(item.labelShow && item.labelHide);
      expect(hasStaticLabel || hasToggleLabel, `${id} 需要 label 或 labelShow/labelHide`).toBe(true);
    }
  });
});
