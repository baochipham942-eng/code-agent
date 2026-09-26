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

  it('aliases 含中文触发词', () => {
    const hasChinese = (s: string) => /[一-鿿]/.test(s);
    expect(findSkill('batch-research')!.aliases?.some(hasChinese)).toBe(true);
    const selfAliases = findSkill('self-awareness')!.aliases ?? [];
    expect(selfAliases.some(hasChinese)).toBe(true);
    // description 里枚举的自我认知触发问法要在 aliases 有对应入口（ai-review Nit 修复钉）
    for (const phrase of ['你是谁', '能做什么', '记得我什么', '连了哪些服务', '有哪些技能', '遵守什么规则']) {
      expect(selfAliases.join(' '), `aliases 应覆盖触发问法「${phrase}」`).toContain(phrase);
    }
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
    // 正文点名 spawn_agent（并行派发）与 collect_agent（后台取回）
    expect(batch.promptContent).toContain('spawn_agent');
    expect(batch.promptContent).toContain('collect_agent');
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
    expect(batch.name).not.toBe(brief.name);
    // batch-research 必须带输出契约（成功 x/N），这是它与单课题拆题的本质区别
    expect(batch.promptContent).toContain('格式「成功 x/N」');
    expect(batch.promptContent).toMatch(/失败清单/);
  });
});
