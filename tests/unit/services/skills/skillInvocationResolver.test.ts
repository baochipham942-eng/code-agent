import { describe, expect, it } from 'vitest';
import type { ParsedSkill } from '../../../../src/shared/contract/agentSkill';
import {
  buildSkillInvocationContext,
  getSkillInvocationAliases,
  resolveSkillInvocationFromSkills,
} from '../../../../src/main/services/skills/skillInvocationResolver';
import { BUILTIN_SKILLS } from '../../../../src/main/services/skills/builtinSkills';

function skill(overrides: Partial<ParsedSkill> & Pick<ParsedSkill, 'name' | 'description'>): ParsedSkill {
  return {
    promptContent: '',
    basePath: `/tmp/${overrides.name}`,
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'user',
    ...overrides,
  };
}

describe('skillInvocationResolver', () => {
  // role-edit-flow 回归护栏：对话式改角色的种子 `/edit-role <roleId>` 必须确定性命中
  // edit-role 内置 skill（否则模型不进上下文 → propose_role 不可见 → 无确认卡，正是验收暴露的根因）。
  it('对话式改角色种子 /edit-role <roleId> 确定性命中 edit-role 内置 skill 并透传 roleId', () => {
    const editRole = BUILTIN_SKILLS.find((s) => s.name === 'edit-role');
    expect(editRole, 'edit-role 内置 skill 应存在').toBeTruthy();
    expect(editRole!.allowedTools).toContain('propose_role');
    expect(editRole!.userInvocable).toBe(true);

    // 与 startEditRoleChat.buildEditRoleSeed 的产物保持一致：`/edit-role <roleId>`
    const resolved = resolveSkillInvocationFromSkills('/edit-role 研究员', [editRole!]);
    expect(resolved).toMatchObject({
      matchKind: 'slash',
      args: '研究员',
      confidence: 1,
    });
    expect(resolved?.skill.name).toBe('edit-role');
  });

  it('resolves a leading slash command before model intent classification', () => {
    const lobster = skill({
      name: 'lobster',
      description: '龙虾(OpenClaw VPS)：当用户提到龙虾、lobster、VPS、OpenClaw 时使用。',
      disableModelInvocation: true,
    });

    const resolved = resolveSkillInvocationFromSkills('/lobster 升级到最新版本', [lobster]);

    expect(resolved).toMatchObject({
      skill: lobster,
      matchKind: 'slash',
      args: '升级到最新版本',
      confidence: 1,
    });
  });

  it('resolves slash mentions embedded in correction text', () => {
    const lobster = skill({
      name: 'lobster',
      description: '龙虾(OpenClaw VPS)：当用户提到龙虾、lobster、VPS、OpenClaw 时使用。',
    });

    const resolved = resolveSkillInvocationFromSkills('就是/lobster啊', [lobster]);

    expect(resolved?.skill.name).toBe('lobster');
    expect(resolved?.matchKind).toBe('inline-slash');
  });

  it('uses metadata and frontmatter aliases without hardcoded product names', () => {
    const deploy = skill({
      name: 'deploy-box',
      description: 'Deploy helper.',
      aliases: ['小盒子'],
      metadata: { aliases: 'box deploy,盒子部署' },
    });

    expect(resolveSkillInvocationFromSkills('把小盒子发一下', [deploy])?.skill.name).toBe('deploy-box');
    expect(resolveSkillInvocationFromSkills('盒子部署走一下', [deploy])?.skill.name).toBe('deploy-box');
  });

  it('extracts conservative trigger aliases from descriptions', () => {
    const lobster = skill({
      name: 'lobster',
      description: '龙虾(OpenClaw VPS)：当用户提到龙虾、lobster、VPS、OpenClaw 时使用。',
    });

    const aliases = getSkillInvocationAliases(lobster).map((alias) => alias.value);

    expect(aliases).toContain('龙虾');
    expect(aliases).toContain('lobster');
    expect(resolveSkillInvocationFromSkills('将我的龙虾升级到最新版本', [lobster])?.skill.name).toBe('lobster');
  });

  it('does not bind ambiguous aliases to an arbitrary skill', () => {
    const first = skill({ name: 'first-tool', description: '用于共享入口。', aliases: ['共享'] });
    const second = skill({ name: 'second-tool', description: '用于共享入口。', aliases: ['共享'] });

    expect(resolveSkillInvocationFromSkills('处理共享', [first, second])).toBeNull();
  });

  it('ignores skills that are not user invocable', () => {
    const hidden = skill({
      name: 'hidden-tool',
      description: 'Hidden helper.',
      aliases: ['隐藏工具'],
      userInvocable: false,
    });

    expect(resolveSkillInvocationFromSkills('/hidden-tool run', [hidden])).toBeNull();
    expect(resolveSkillInvocationFromSkills('隐藏工具 run', [hidden])).toBeNull();
  });

  it('renders inline skill locations without a fake SKILL.md path', async () => {
    const inline = skill({
      name: 'inline-tool',
      description: 'Inline helper.',
      promptContent: 'Inline instructions',
      basePath: '',
      source: 'builtin',
      loaded: true,
    });

    const context = await buildSkillInvocationContext({
      skill: inline,
      matchedText: '/inline-tool',
      matchKind: 'slash',
      args: '',
      confidence: 1,
    }, '/tmp/work');

    expect(context.block).toContain('Skill source: builtin inline skill');
    expect(context.block).not.toContain('/SKILL.md');
  });

  it('does not pre-approve tools from cloud skills', async () => {
    const cloud = skill({
      name: 'cloud-tool',
      description: 'Cloud helper.',
      promptContent: 'Cloud instructions',
      basePath: '',
      source: 'cloud',
      loaded: true,
      allowedTools: ['Bash(git:*)'],
    });

    const context = await buildSkillInvocationContext({
      skill: cloud,
      matchedText: '/cloud-tool',
      matchKind: 'slash',
      args: '',
      confidence: 1,
    }, '/tmp/work');

    expect(context.contextModifier.preApprovedTools).toBeUndefined();
    expect(context.block).toContain('source="cloud"');
    expect(context.block).toContain('Skill source: cloud inline skill');
  });
});
