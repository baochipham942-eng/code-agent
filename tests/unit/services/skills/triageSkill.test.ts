// ============================================================================
// triage（批量分拣技能）Tests — N-JEV-DECIDE-TOOL
// ----------------------------------------------------------------------------
// 守四件事：技能真的进了 BUILTIN_SKILLS 且分类回填 automation；allowedTools
// 全部可被 ToolSearch 发现（builtinSkillToolDiscoverability 的单技能版）；
// 正文是「判准先行 → 10 条试跑 → 全量分批」三步且顺序正确；decide 不可用时
// 明说并禁止用主模型模仿。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { getBuiltinSkill } from '../../../../src/host/services/skills/builtinSkills';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkillsData';
import { TRIAGE_SKILL } from '../../../../src/host/services/skills/triageSkill';
import {
  CORE_TOOLS,
  DEFERRED_TOOLS_META,
  resolveToolAlias,
} from '../../../../src/host/services/toolSearch/deferredTools';

describe('triage builtin skill', () => {
  it('exists in the builtin registry with category automation and builtin source', () => {
    const skill = getBuiltinSkill('triage');
    expect(skill).toBeDefined();
    expect(skill?.source).toBe('builtin');
    expect(skill?.metadata?.category).toBe('automation');
    expect(BUILTIN_SKILLS.some((entry) => entry.name === 'triage')).toBe(true);
  });

  it('declares only tools the model can discover via ToolSearch', () => {
    expect(TRIAGE_SKILL.allowedTools).toEqual(['decide', 'Read', 'Write', 'Glob']);
    const discoverable = new Set([
      ...CORE_TOOLS,
      ...DEFERRED_TOOLS_META.map((meta) => meta.name),
    ]);
    for (const tool of TRIAGE_SKILL.allowedTools) {
      expect(discoverable.has(resolveToolAlias(tool))).toBe(true);
    }
  });

  it('spells out the three steps with criteria written to a file BEFORE any batch', () => {
    const body = TRIAGE_SKILL.promptContent;
    const step1 = body.indexOf('第一步');
    const trial = body.indexOf('10 条');
    const step3 = body.indexOf('第三步');
    expect(step1).toBeGreaterThanOrEqual(0);
    expect(trial).toBeGreaterThan(step1);
    expect(step3).toBeGreaterThan(trial);

    // 判准先行：先写文件、批中不改。
    expect(body).toContain('判准');
    expect(body).toMatch(/写.*文件/);
    expect(body).toMatch(/批中不改|中途.*不改|冻结/);
    // 批量上限与置信门槛。
    expect(body).toContain('32');
    expect(body).toContain('0.7');
    // 产出两份清单。
    expect(body).toMatch(/可直接处理.*清单/s);
    expect(body).toMatch(/需人工复核.*清单|人工复核清单/s);
  });

  it('tells the user instead of imitating decide with the main model when no Jev route exists', () => {
    const body = TRIAGE_SKILL.promptContent;
    expect(body).toContain('decide 不可用');
    expect(body).toMatch(/主模型逐条|逐条判/);
    expect(body).toMatch(/告诉用户|直接告诉用户/);
  });
});
