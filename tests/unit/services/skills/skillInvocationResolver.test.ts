import { describe, expect, it, vi } from 'vitest';
import type { ParsedSkill } from '../../../../src/shared/contract/agentSkill';
import {
  buildSkillInvocationContext,
  getSkillInvocationAliases,
  resolveSkillInvocationFromSkills,
} from '../../../../src/host/services/skills/skillInvocationResolver';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkills';

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
  it('建团队和建改角色都可查询权威专家名册', () => {
    for (const name of ['create-team', 'create-role', 'edit-role']) {
      expect(BUILTIN_SKILLS.find((skill) => skill.name === name)?.allowedTools).toContain('list_experts');
    }
  });

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

  it('/dream 确定性命中 dream 内置 skill，并收缩到 History + Memory 工具', async () => {
    const dream = BUILTIN_SKILLS.find((s) => s.name === 'dream');
    expect(dream, 'dream 内置 skill 应存在').toBeTruthy();
    expect(dream!.userInvocable).toBe(true);
    expect(dream!.agent).toBe('dream');
    expect(dream!.allowedTools).toEqual(expect.arrayContaining(['History', 'MemoryRead', 'MemoryWrite']));

    const resolved = resolveSkillInvocationFromSkills('/dream --auto', [dream!]);
    expect(resolved).toMatchObject({
      matchKind: 'slash',
      args: '--auto',
      confidence: 1,
    });
    expect(resolved?.skill.name).toBe('dream');

    const context = await buildSkillInvocationContext(resolved!, '/repo');
    expect(context.contextModifier.toolBoundary?.skillName).toBe('dream');
    expect(context.contextModifier.toolBoundary?.allowedTools).toEqual(expect.arrayContaining(['History', 'MemoryRead', 'MemoryWrite']));
    expect(context.block).toContain('轨迹库为权威');
    expect(context.block).toContain('不要直接查询 SQLite');
  });

  it('/distill 确定性命中 distill 内置 skill，并把 turn 收缩到只读呈现工具', async () => {
    const distill = BUILTIN_SKILLS.find((s) => s.name === 'distill');
    expect(distill, 'distill 内置 skill 应存在').toBeTruthy();
    expect(distill!.userInvocable).toBe(true);
    expect(distill!.agent).toBe('distill');
    expect(distill!.strictToolset).toBe(true);
    // 落盘发生在 service 层 executor，turn 内模型不需要任何写工具
    expect(distill!.allowedTools).not.toContain('Write');
    expect(distill!.allowedTools).not.toContain('SkillCreate');
    expect(distill!.allowedTools).not.toContain('Bash');

    const resolved = resolveSkillInvocationFromSkills('/distill --auto', [distill!]);
    expect(resolved).toMatchObject({
      matchKind: 'slash',
      args: '--auto',
      confidence: 1,
    });
    expect(resolved?.skill.name).toBe('distill');

    const context = await buildSkillInvocationContext(resolved!, '/repo');
    expect(context.contextModifier.toolBoundary?.skillName).toBe('distill');
    expect(context.contextModifier.toolBoundary?.strict).toBe(true);
  });

  describe('executor 注册表桥（buildSkillInvocationContext 的执行副作用）', () => {
    const EXEC_SKILL = 'exec-bridge-test';

    function execSkill(): ParsedSkill {
      return skill({ name: EXEC_SKILL, description: 'executor bridge test skill', promptContent: 'present the report', loaded: true });
    }

    it('注册了 executor 的 skill 显式触发 → 运行报告注入上下文块', async () => {
      const { registerSkillExecutor, unregisterSkillExecutor } = await import(
        '../../../../src/host/services/skills/skillExecutorRegistry'
      );
      registerSkillExecutor(EXEC_SKILL, async (req) => `EXECUTED with args=${req.args ?? ''}`);
      try {
        const resolved = resolveSkillInvocationFromSkills(`/${EXEC_SKILL} --auto`, [execSkill()]);
        const context = await buildSkillInvocationContext(resolved!, '/repo');
        expect(context.block).toContain('<skill-execution-report status="completed">');
        expect(context.block).toContain('EXECUTED with args=--auto');
      } finally {
        unregisterSkillExecutor(EXEC_SKILL);
      }
    });

    it('executor 抛错 → 降级为失败说明块，不打断上下文构建', async () => {
      const { registerSkillExecutor, unregisterSkillExecutor } = await import(
        '../../../../src/host/services/skills/skillExecutorRegistry'
      );
      registerSkillExecutor(EXEC_SKILL, async () => {
        throw new Error('service down');
      });
      try {
        const resolved = resolveSkillInvocationFromSkills(`/${EXEC_SKILL}`, [execSkill()]);
        const context = await buildSkillInvocationContext(resolved!, '/repo');
        expect(context.block).toContain('<skill-execution-report status="failed">');
        expect(context.block).toContain('service down');
      } finally {
        unregisterSkillExecutor(EXEC_SKILL);
      }
    });

    it('alias 模糊匹配不执行 executor，块中无执行报告', async () => {
      const { registerSkillExecutor, unregisterSkillExecutor } = await import(
        '../../../../src/host/services/skills/skillExecutorRegistry'
      );
      const executor = vi.fn(async () => 'should not run');
      registerSkillExecutor(EXEC_SKILL, executor);
      try {
        const resolved = resolveSkillInvocationFromSkills(`/${EXEC_SKILL}`, [execSkill()]);
        const aliasInvocation = { ...resolved!, matchKind: 'alias' as const };
        const context = await buildSkillInvocationContext(aliasInvocation, '/repo');
        expect(executor).not.toHaveBeenCalled();
        expect(context.block).not.toContain('skill-execution-report');
      } finally {
        unregisterSkillExecutor(EXEC_SKILL);
      }
    });

    it('未注册 executor 的 skill 行为不变（无执行报告块）', async () => {
      const plain = skill({ name: 'plain-skill', description: 'no executor', promptContent: 'plain', loaded: true });
      const resolved = resolveSkillInvocationFromSkills('/plain-skill', [plain]);
      const context = await buildSkillInvocationContext(resolved!, '/repo');
      expect(context.block).not.toContain('skill-execution-report');
    });
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

  // skill-alias 词边界回归：description 里的否定声明（"不要因为用户提到 page 等关键词就
  // 自动触发"）不应被解析成正面触发别名，且拉丁别名不应子串命中标识符（page_size）。
  it('does not treat a design-brief-style negated keyword list as trigger aliases', () => {
    const designBrief = skill({
      name: 'design-brief',
      description:
        '生成结构化设计简报。【仅手动触发】仅在用户明确说 `/design-brief`、"写设计简报" 时调用。' +
        '不要因为用户提到 plan/feature/page/landing/UI direction 等关键词就自动触发。',
    });

    const aliases = getSkillInvocationAliases(designBrief).map((alias) => alias.value);
    expect(aliases).not.toContain('page');
    expect(aliases).not.toContain('plan');
    expect(aliases).not.toContain('feature');
    expect(aliases).not.toContain('landing');

    expect(resolveSkillInvocationFromSkills('把 page_size 参数改成 50', [designBrief])).toBeNull();
  });

  it('/design-brief 仍确定性命中 design-brief skill', () => {
    const designBrief = skill({
      name: 'design-brief',
      description:
        '生成结构化设计简报。【仅手动触发】仅在用户明确说 `/design-brief`、"写设计简报" 时调用。' +
        '不要因为用户提到 plan/feature/page/landing/UI direction 等关键词就自动触发。',
    });

    expect(resolveSkillInvocationFromSkills('/design-brief 做个 onboarding 流程', [designBrief])?.skill.name).toBe(
      'design-brief',
    );
  });

  // 隔离验证否定回看：只测 alias 提取本身，不牵涉词边界匹配。
  it('negation lookbehind alone strips triggers from a negated description clause', () => {
    const negated = skill({
      name: 'negation-only-tool',
      description: '一些说明。不要因为用户提到 zzzcanary 等关键词就自动触发。',
    });

    const aliases = getSkillInvocationAliases(negated).map((alias) => alias.value);
    expect(aliases).not.toContain('zzzcanary');
  });

  // 隔离验证词边界：alias 来自 metadata（不经过否定回看），单独测子串误伤。
  it('word boundary alone prevents a short latin alias from matching inside an identifier', () => {
    const shortAlias = skill({
      name: 'short-alias-tool',
      description: 'no trigger words here.',
      metadata: { aliases: 'page' },
    });

    expect(resolveSkillInvocationFromSkills('把 page_size 参数改成 50', [shortAlias])).toBeNull();
    expect(resolveSkillInvocationFromSkills('把 page 参数改一下', [shortAlias])?.skill.name).toBe(
      'short-alias-tool',
    );
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
      aliases: [],
      reason: 'explicit slash command',
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
      aliases: [],
      reason: 'explicit slash command',
    }, '/tmp/work');

    expect(context.contextModifier.preApprovedTools).toBeUndefined();
    expect(context.block).toContain('source="cloud"');
    expect(context.block).toContain('Skill source: cloud inline skill');
  });

  // role-edit-flow：strictToolset 必须流进 toolBoundary.strict，inference 才会硬收缩可见工具集
  it('strictToolset 透传到 contextModifier.toolBoundary.strict', async () => {
    const editRole = skill({
      name: 'edit-role',
      description: 'edit a role',
      promptContent: 'edit role instructions',
      basePath: '',
      source: 'builtin',
      loaded: true,
      allowedTools: ['propose_role', 'read_file'],
      strictToolset: true,
    });
    const context = await buildSkillInvocationContext({
      skill: editRole,
      matchedText: '/edit-role',
      matchKind: 'slash',
      args: '研究员',
      confidence: 1,
      aliases: [],
      reason: 'explicit slash command',
    }, '/tmp/work');
    expect(context.contextModifier.toolBoundary?.strict).toBe(true);
    expect(context.contextModifier.toolBoundary?.allowedTools).toEqual(['propose_role', 'read_file']);
  });

  it('未设 strictToolset 的 skill → toolBoundary.strict 为 false（软边界不变）', async () => {
    const soft = skill({
      name: 'soft-skill',
      description: 'soft',
      promptContent: 'x',
      basePath: '',
      source: 'builtin',
      loaded: true,
      allowedTools: ['Read'],
    });
    const context = await buildSkillInvocationContext({
      skill: soft,
      matchedText: '/soft-skill',
      matchKind: 'slash',
      args: '',
      confidence: 1,
      aliases: [],
      reason: 'explicit slash command',
    }, '/tmp/work');
    expect(context.contextModifier.toolBoundary?.strict).toBe(false);
  });
});
