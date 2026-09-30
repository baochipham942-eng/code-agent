// ============================================================================
// SkillsInstalledTab 项目级覆盖 UI —— 渲染 + 三态映射（验收 #5 组件测试）
// 走 renderToStaticMarkup + 真 useI18n(默认 zh)，验证每行的项目覆盖下拉、
// 三个选项文案、当前选中态、以及"项目覆盖"徽标区分全局态 vs 项目覆盖态。
// 切换→IPC 调用链见 tests/unit/ipc/skill.ipc.test.ts（SKILL_PROJECT_SET/CLEAR）。
// ============================================================================

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { en, zh } from '../../../src/renderer/i18n';
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
      onExportSkill: noop,
      onInstallFromZip: noop,
      onDropZipFile: noop,
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

  it('同名 Skill 被官方版本压住时显示改名出口', () => {
    const skill = makeSkill('shadowed', null);
    skill.source = 'plugin';
    skill.officialConflict = { winnerSource: 'plugin', blockedSkills: [{ source: 'project', basePath: '/project/skills/shadowed' }] };
    const html = render([skill]);
    expect(html).toContain('已被同名官方技能覆盖，未加载');
    expect(html).toContain('项目技能 /project/skills/shadowed/SKILL.md');
    expect(html).not.toMatch(/>shadowed\/SKILL\.md</);
    expect(html).toContain('请修改上述 SKILL.md 的 name 和目录名后重新加载');
  });

  it('用户、项目、技能库各显示来源标签和完整路径，不再只剩目录末段', () => {
    const skill = makeSkill('xlsx', null);
    skill.source = 'plugin';
    skill.officialConflict = {
      winnerSource: 'plugin',
      blockedSkills: [
        { source: 'user', basePath: '/opt/skills/user/xlsx/' },
        { source: 'project', basePath: '/opt/skills/project/xlsx' },
        { source: 'library', basePath: '/opt/skills/library/pack/xlsx' },
      ],
    };
    const html = render([skill]);
    expect(html).toContain('用户技能 /opt/skills/user/xlsx/SKILL.md');
    expect(html).toContain('项目技能 /opt/skills/project/xlsx/SKILL.md');
    expect(html).toContain('技能库 /opt/skills/library/pack/xlsx/SKILL.md');
    expect(html).not.toMatch(/>xlsx\/SKILL\.md</);
    expect(html).toContain('请修改上述 SKILL.md 的 name 和目录名后重新加载');
  });

  it('Windows 路径保留反斜杠并去掉末尾分隔符', () => {
    const skill = makeSkill('xlsx', null);
    skill.source = 'plugin';
    skill.officialConflict = {
      winnerSource: 'plugin',
      blockedSkills: [{ source: 'user', basePath: 'C:\\skills\\user\\xlsx\\' }],
    };
    const html = render([skill]);
    expect(html).toContain('用户技能 C:\\skills\\user\\xlsx\\SKILL.md');
    expect(html).toContain('title="C:\\skills\\user\\xlsx\\SKILL.md"');
    expect(html).not.toContain('xlsx/SKILL.md');
    expect(html).not.toContain('xlsx\\\\SKILL.md');
  });

  it('user/project/library 以外的来源回退为原始 source 字符串', () => {
    const skill = makeSkill('xlsx', null);
    skill.source = 'builtin';
    skill.officialConflict = {
      winnerSource: 'builtin',
      blockedSkills: [{ source: 'cloud', basePath: '/opt/skills/cloud/xlsx' }],
    };
    const html = render([skill]);
    expect(html).toContain('cloud /opt/skills/cloud/xlsx/SKILL.md');
    expect(html).not.toMatch(/>xlsx\/SKILL\.md</);
  });
});

describe('officialConflictSources i18n', () => {
  it('zh 与 en 都有 user、project、library 三条非空且互不相同的来源文案', () => {
    const zhSources = zh.settings.skills.installed.officialConflictSources;
    const enSources = en.settings.skills.installed.officialConflictSources;
    for (const source of ['user', 'project', 'library'] as const) {
      expect(zhSources[source].length).toBeGreaterThan(0);
      expect(enSources[source].length).toBeGreaterThan(0);
      expect(enSources[source]).not.toBe(zhSources[source]);
    }
  });
});
