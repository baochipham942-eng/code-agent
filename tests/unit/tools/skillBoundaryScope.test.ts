// ============================================================================
// skillBoundaryScope 测试 — strict-toolset skill 可见工具集硬收缩
// ============================================================================

import { describe, it, expect } from 'vitest';
import { filterToolDefinitionsByStrictSkillBoundary } from '../../../src/main/tools/skillBoundaryScope';
import type { SkillToolBoundary } from '../../../src/shared/contract/agentSkill';

const tools = [
  { name: 'Edit' },
  { name: 'Write' },
  { name: 'Bash' },
  { name: 'Read' },
  { name: 'Glob' },
  { name: 'Grep' },
  { name: 'AskUserQuestion' },
  { name: 'propose_role' },
  { name: 'Skill' },
  { name: 'ToolSearch' },
];

// edit-role 的 allowedTools（含 snake_case 别名，应被归一）
const editRoleBoundary: SkillToolBoundary = {
  skillName: 'edit-role',
  strict: true,
  allowedTools: ['propose_role', 'read_file', 'ask_user_question', 'glob', 'grep'],
};

describe('filterToolDefinitionsByStrictSkillBoundary', () => {
  it('strict 时只保留 allowedTools（含别名归一），隐藏 Edit/Write/Bash/Skill/ToolSearch', () => {
    const visible = filterToolDefinitionsByStrictSkillBoundary(tools, editRoleBoundary).map((t) => t.name);
    // 边界内（read_file→Read, ask_user_question→AskUserQuestion, glob→Glob, grep→Grep）
    expect(visible.sort()).toEqual(['AskUserQuestion', 'Glob', 'Grep', 'Read', 'propose_role'].sort());
    // 关键：模型看不到 Edit/Write → 物理上无法绕过 propose_role 直接改文件
    expect(visible).not.toContain('Edit');
    expect(visible).not.toContain('Write');
    expect(visible).not.toContain('Bash');
  });

  it('非 strict（软边界）时原样返回，不改 GAP-001 行为', () => {
    const soft: SkillToolBoundary = { skillName: 'some-skill', allowedTools: ['Read'] };
    expect(filterToolDefinitionsByStrictSkillBoundary(tools, soft)).toEqual(tools);
  });

  it('无边界 / 空 allowedTools 原样返回', () => {
    expect(filterToolDefinitionsByStrictSkillBoundary(tools, undefined)).toEqual(tools);
    expect(
      filterToolDefinitionsByStrictSkillBoundary(tools, { skillName: 'x', strict: true, allowedTools: [] }),
    ).toEqual(tools);
  });

  it('支持 Bash(git:*) 模式前缀：保留 Bash 基础名', () => {
    const boundary: SkillToolBoundary = {
      skillName: 'git-skill',
      strict: true,
      allowedTools: ['Bash(git:*)', 'read_file'],
    };
    const visible = filterToolDefinitionsByStrictSkillBoundary(tools, boundary).map((t) => t.name);
    expect(visible.sort()).toEqual(['Bash', 'Read'].sort());
  });
});
