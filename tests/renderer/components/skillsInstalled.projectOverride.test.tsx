// ============================================================================
// SkillsInstalledTab 项目级覆盖 UI —— 渲染 + 三态映射（验收 #5 组件测试）
// 走 renderToStaticMarkup + 真 useI18n(默认 zh)，验证每行的项目覆盖下拉、
// 三个选项文案、当前选中态、以及"项目覆盖"徽标区分全局态 vs 项目覆盖态。
// 切换→IPC 调用链见 tests/unit/ipc/skill.ipc.test.ts（SKILL_PROJECT_SET/CLEAR）。
// ============================================================================

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SkillsInstalledTab,
  overrideToSelectValue,
  type InstalledSkill,
} from '../../../src/renderer/components/features/settings/tabs/SkillsInstalledTab';

function makeSkill(name: string, over: boolean | null, globalEnabled = true): InstalledSkill {
  return {
    name,
    description: `${name} desc`,
    promptContent: '',
    basePath: `/u/${name}`,
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'user',
    globalEnabled,
    projectOverride: over,
    enabled: over ?? globalEnabled,
  };
}

const noop = () => {};

function render(skills: InstalledSkill[]): string {
  return renderToStaticMarkup(
    React.createElement(SkillsInstalledTab, {
      skills,
      libraries: [],
      actionLoading: null,
      onToggleSkill: noop,
      onProjectOverrideChange: noop,
      onUpdateLibrary: noop,
      onRemoveLibrary: noop,
    }),
  );
}

describe('overrideToSelectValue', () => {
  it('true→on false→off null/undefined→follow', () => {
    expect(overrideToSelectValue(true)).toBe('on');
    expect(overrideToSelectValue(false)).toBe('off');
    expect(overrideToSelectValue(null)).toBe('follow');
    expect(overrideToSelectValue(undefined)).toBe('follow');
  });
});

describe('SkillsInstalledTab 项目覆盖渲染', () => {
  it('每个 skill 渲染项目覆盖下拉 + 三个选项文案', () => {
    const html = render([makeSkill('alpha', null)]);
    expect(html).toContain('aria-label="本项目内启停 alpha"');
    expect(html).toContain('跟随全局');
    expect(html).toContain('本项目启用');
    expect(html).toContain('本项目禁用');
  });

  it('有覆盖的行显示"项目覆盖"徽标，跟随全局的行不显示', () => {
    const html = render([
      makeSkill('a-follow', null),
      makeSkill('b-off', false),
      makeSkill('c-on', true, false),
    ]);
    // 2 个覆盖 → 2 个徽标
    const badgeCount = html.split('项目覆盖').length - 1;
    expect(badgeCount).toBe(2);
    // 3 行都有下拉
    const selectCount = html.split('本项目内启停').length - 1;
    expect(selectCount).toBe(3);
  });

  it('选中态反映 projectOverride：off 覆盖时下拉选中"本项目禁用"', () => {
    const html = render([makeSkill('b-off', false)]);
    // React 静态渲染把选中项标 selected
    expect(html).toMatch(/<option value="off" selected="">本项目禁用<\/option>/);
  });
});
