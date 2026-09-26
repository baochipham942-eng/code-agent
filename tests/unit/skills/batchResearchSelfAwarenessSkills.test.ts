// ============================================================================
// 内置 skill：batch-research（批量调研）+ self-awareness（自我认知）
// ----------------------------------------------------------------------------
// 验收（N-SKILL-BATCH-RESEARCH-SELFAWARE）：
//  ① 两个 skill 可被发现（builtin 集合内、userInvocable）
//  ② description 同时写清「做什么」与「何时触发」；aliases 含中文
//  ③ self-awareness 的 allowedTools 全部是 readOnly 工具（对照真实 ToolSchema，
//     不是对照一份手抄名单——手抄名单会跟着 skill 一起漂）
//  ④ skill 正文点名的核心工具名真实存在且模型可发现（CORE ∪ DEFERRED）
// ============================================================================
import { describe, it, expect } from 'vitest';
import { getBuiltinSkills } from '../../../src/host/services/skills/builtinSkills';
import { resolveSkillInvocationFromSkills } from '../../../src/host/services/skills/skillInvocationResolver';
import { CORE_TOOLS, DEFERRED_TOOLS_META } from '../../../src/host/services/toolSearch/deferredTools';
import { historySchema } from '../../../src/host/tools/modules/lightMemory/history.schema';
import { memoryReadSchema } from '../../../src/host/tools/modules/lightMemory/memoryRead.schema';
import { memorySearchSchema } from '../../../src/host/tools/modules/lightMemory/memorySearch.schema';
import { spaceListSchema } from '../../../src/host/tools/modules/planning/spaceList.schema';
import { spaceQuerySchema } from '../../../src/host/tools/modules/planning/spaceQuery.schema';
import { readSchema } from '../../../src/host/tools/modules/file/read.schema';
import { globSchema } from '../../../src/host/tools/modules/file/glob.schema';
import { grepSchema } from '../../../src/host/tools/modules/shell/grep.schema';

const SKILLS = getBuiltinSkills();

function findSkill(name: string) {
  return SKILLS.find((s) => s.name === name);
}

describe('builtin skills: batch-research / self-awareness', () => {
  it('两个 skill 都注册为 user-invocable builtin', () => {
    for (const name of ['batch-research', 'self-awareness']) {
      const skill = findSkill(name);
      expect(skill, `missing builtin skill: ${name}`).toBeDefined();
      expect(skill!.userInvocable, name).toBe(true);
      expect(skill!.source, name).toBe('builtin');
      expect(skill!.promptContent.length, name).toBeGreaterThan(300);
    }
    expect(findSkill('batch-research')!.metadata?.category).toBe('research');
    // SkillCategory 无 general/assistant；development 已收留 dream/distill 这类助手元能力
    expect(findSkill('self-awareness')!.metadata?.category).toBe('development');
  });

  it('description 同时写清做什么与何时触发', () => {
    const batch = findSkill('batch-research')!;
    // 做什么：批量对象逐个查证汇总
    expect(batch.description).toMatch(/逐个查证/);
    // 何时触发 / 何时不用：一批同构对象 + 单个对象不适用
    expect(batch.description).toMatch(/一批同构对象/);
    expect(batch.description).toMatch(/单个对象/);

    const self = findSkill('self-awareness')!;
    // 做什么：现场重查后作答
    expect(self.description).toMatch(/现场重查/);
    // 何时触发：自我相关问题（至少命中两类问法）
    expect(self.description).toMatch(/你是谁/);
    expect(self.description).toMatch(/记得我什么|能做什么/);
  });

  it('aliases 只留低歧义专名，通用问法写在 description', () => {
    const hasChinese = (s: string) => /[一-鿿]/.test(s);
    const batchAliases = findSkill('batch-research')!.aliases ?? [];
    const selfAliases = findSkill('self-awareness')!.aliases ?? [];
    expect(batchAliases.some(hasChinese)).toBe(true);
    expect(selfAliases.some(hasChinese)).toBe(true);
    expect(batchAliases).toEqual(expect.arrayContaining(['批量调研', 'wide research', 'batch research']));
    expect(selfAliases).toEqual(expect.arrayContaining(['自我认知', 'self awareness']));
    // 通用中文别名按子串匹配且 frontmatter 得分 0.9，会把日常句强制注入 skill
    // （skillInvocationResolver.ts CJK includes + N-L8-ATT10 同类教训）
    for (const generic of ['批量查询', '各查一下', '逐个查一下', '你能做什么', '有哪些技能', '遵守什么规则', '连了哪些服务']) {
      expect(batchAliases, `batch-research 不应把「${generic}」当 alias`).not.toContain(generic);
      expect(selfAliases, `self-awareness 不应把「${generic}」当 alias`).not.toContain(generic);
    }
    const self = findSkill('self-awareness')!;
    expect(self.description).toMatch(/你能做什么/);
    expect(self.description).toMatch(/有哪些技能/);
    expect(self.description).toMatch(/遵守什么规则/);
    expect(self.description).toMatch(/连了哪些服务/);
  });

  it('日常通用句子不会被解析成 batch-research / self-awareness', () => {
    const skills = getBuiltinSkills();
    const guarded = new Set(['batch-research', 'self-awareness']);
    const sentences = [
      '写个批量查询订单的 SQL',
      '这份简历有哪些技能要补',
      '这个接口要遵守什么规则',
      '这个微服务连了哪些服务',
    ];
    for (const sentence of sentences) {
      const resolved = resolveSkillInvocationFromSkills(sentence, skills);
      expect(
        resolved && guarded.has(resolved.skill.name),
        `「${sentence}」不应解析为 ${resolved?.skill.name}`,
      ).toBeFalsy();
    }
    expect(resolveSkillInvocationFromSkills('批量调研这 30 家公司', skills)?.skill.name).toBe('batch-research');
    expect(resolveSkillInvocationFromSkills('自我认知：你记得我什么', skills)?.skill.name).toBe('self-awareness');
  });

  it('self-awareness 的 allowedTools 全部对照真实 ToolSchema 为 readOnly', () => {
    const readOnlySchemas = [
      memoryReadSchema,
      memorySearchSchema,
      historySchema,
      spaceListSchema,
      spaceQuerySchema,
      readSchema,
      globSchema,
      grepSchema,
    ];
    // 先证明对照表本身没有说谎：每个 schema 的 readOnly 都为 true
    for (const schema of readOnlySchemas) {
      expect(schema.readOnly, schema.name).toBe(true);
    }
    const readOnlyByName = new Map(readOnlySchemas.map((schema) => [schema.name, schema.readOnly]));
    const skill = findSkill('self-awareness')!;
    for (const tool of skill.allowedTools) {
      // 不在对照表里 = 引入了未经只读校验的新工具，直接红
      expect(readOnlyByName.has(tool), `self-awareness 工具 ${tool} 不在只读对照表`).toBe(true);
    }
    // allowedTools 非空，防止「空集天然全绿」
    expect(skill.allowedTools.length).toBeGreaterThan(0);
  });

  it('正文点名的核心工具真实存在且模型可发现', () => {
    const discoverable = new Set([...CORE_TOOLS, ...DEFERRED_TOOLS_META.map((m) => m.name)]);
    const batch = findSkill('batch-research')!;
    // 正文点名 spawn_agent（并行派发）与 collect_agent（后台取回）；
    // agents[] 每项 role 填内置调研角色 explore，避免模型编造未知 role
    expect(batch.promptContent).toContain('spawn_agent');
    expect(batch.promptContent).toContain('collect_agent');
    expect(batch.promptContent).toContain('role 填 explore');
    expect(discoverable.has('spawn_agent')).toBe(true);
    expect(discoverable.has('collect_agent')).toBe(true);
    // 后台链路配对（ai-review Important 1 修复钉）：collect_agent 只认
    // run_in_background: true 注册进 BackgroundSubagentRegistry 的代理；
    // waitForCompletion: false 是 SpawnGuard/wait_agent 链路，不许再混用
    expect(batch.promptContent).toContain('run_in_background');
    expect(batch.promptContent).not.toContain('waitForCompletion');
    // builtin skill 的 allowedTools 会整体进入预授权集合（skillInvocationResolver
    // canSkillAutoPreApproveTools），无对应需求的 skill 不许带写能力工具
    // （Write/Edit 写文件，TaskManager 的 replace 动作可整替任务计划）
    expect(batch.allowedTools).not.toContain('Write');
    expect(batch.allowedTools).not.toContain('Edit');
    expect(batch.allowedTools).not.toContain('TaskManager');

    const self = findSkill('self-awareness')!;
    // 正文点名记忆/历史/空间三类查证工具
    for (const tool of ['MemoryRead', 'memory_search', 'History', 'space_list', 'space_query']) {
      expect(self.promptContent, `self-awareness 正文应点名 ${tool}`).toContain(tool);
      expect(discoverable.has(tool), tool).toBe(true);
    }
    // space_query 的 skills 只含空间级显式覆盖（spaceOperationsService.query 取
    // getAllOverrides 的 true 项），不能当全局技能清单答「有哪些技能」（第二轮 Important 2 修复钉）
    expect(self.promptContent).toContain('查到空列表不等于没有技能');
  });

  it('batch-research 与 research-brief-and-split 职责不重叠（前者管批量覆盖，后者管单课题拆题）', () => {
    const batch = findSkill('batch-research')!;
    const brief = findSkill('research-brief-and-split')!;
    // batch-research 管批量覆盖率；research-brief-and-split 管单课题拆题，不报 x/N
    expect(batch.promptContent).toContain('格式「成功 x/N」');
    expect(batch.promptContent).toMatch(/失败清单/);
    expect(brief.promptContent).not.toContain('格式「成功 x/N」');
    expect(brief.promptContent).toMatch(/拆/);
  });
});
