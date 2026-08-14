// ============================================================================
// 「注册即可发现」门 —— 注册了的工具，模型必须有一条到达路径
// ----------------------------------------------------------------------------
// 2026-08-14 N-L8-ATT6 调研实测：registry 注册 130 个工具，其中 35 个 `select:<name>`
// 拿不到自己——19 个是真·不可达（模型既看不见也搜不到，能力等于不存在），其余是门面
// 覆盖或 strict skill 注入。已有的 builtinSkillToolDiscoverability 门只管「内置 skill
// 声明的工具可发现」，管不到「注册了但没人声明」的工具，这 19 个就是从那个缺口漏下去的。
//
// 本门补的正是那个缺口：以 registry 注册表为真源，逐个问「模型怎么够得着它」。
//
// 判据——每个注册工具必须满足至少一条：
//   ① 在 CORE_TOOLS 里（每轮常驻，模型直接看得见）
//   ② ToolSearchService.selectTool(name) 命中它自己（在 DEFERRED_TOOLS_META 索引里）
//   ③ 由一个「自身可发现的门面工具」代理（REACHABLE_VIA_FACADE，值必须过 ①②）
//   ④ 被 strict skill 直接注入工具集（不走 ToolSearch，故不要求进索引）
//
// 判据取真实 selectTool() 而非集合成员判断：alias 解析会让 `select:web_fetch` 实际拿到
// `WebFetch`——「查得到」和「查到的是它自己」是两件事，只有真调一次才分得清。
//
// 门的盲区自陈：
//   1) 只管「够得着」，不管「调用真能成」（权限/参数/handler 健康另有其门）
//   2) 门面覆盖只校验门面工具自身可发现，不校验门面真的转发了所有子能力
//   3) 只扫 registerMigratedTools 注册的 native 工具，管不到 plugins/ 与 MCP 动态工具
//   4) UNREACHABLE_BASELINE 是存量基线，**只许变短不许变长**
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { ToolSchema } from '../../../src/host/protocol/tools';
import { registerMigratedTools } from '../../../src/host/tools/modules';
import { CORE_TOOLS } from '../../../src/host/services/toolSearch/deferredTools';
import { ToolSearchService } from '../../../src/host/services/toolSearch/toolSearchService';
import { BUILTIN_SKILLS } from '../../../src/host/services/skills/builtinSkillsData';

/**
 * 门面覆盖：`子工具 → 代理它的门面工具`。
 * 子工具刻意不进发现索引，能力由门面暴露给模型（少一个工具进表，省 schema 预算）。
 * 每条的门面工具名会被断言「自身可发现」——门面若被删/改名/挪出索引，本门立刻红。
 */
const REACHABLE_VIA_FACADE: Record<string, string> = {
  // TaskManager 门面（taskManager.ts 直接 import 这四个的 execute*）
  task_create: 'TaskManager',
  task_update: 'TaskManager',
  task_get: 'TaskManager',
  task_list: 'TaskManager',
  // Plan 门面（planFacade.ts）
  plan_read: 'Plan',
  plan_update: 'Plan',
  plan_recover_recent_work: 'Plan',
  // PlanMode 门面（planModeFacade.ts）
  enter_plan_mode: 'PlanMode',
  exit_plan_mode: 'PlanMode',
  // MCPUnified 门面（mcpUnified.ts）
  mcp: 'MCPUnified',
  mcp_add_server: 'MCPUnified',
  // 其余单点门面
  read_docx: 'ReadDocument',
  xlwings_execute: 'ExcelAutomate',
  pdf_compress: 'PdfAutomate',
  web_fetch: 'WebFetch',
};

/**
 * strict skill 直接注入工具集，不走 ToolSearch，故不要求进发现索引。
 * 会被断言「确实仍有 strict skill 在用」——最后一个引用消失时本门报红，提醒清理。
 */
const STRICT_SKILL_INJECTED = new Set<string>(['exit_role_flow']);

/**
 * 存量真·不可达名单（**只许变短**）。2026-08-14 建门时钉住 19 条。
 *
 * 这些工具注册了、能执行，但模型既看不见（不在 CORE）也搜不到（不在 DEFERRED_TOOLS_META），
 * 也没有门面代理——等于能力不存在。逐条要么补进发现索引、要么补门面、要么删掉。
 *
 * 再加名字进来之前先想清楚：是「该藏起来」还是「忘了登记」。前者补进 REACHABLE_VIA_FACADE
 * 并写明门面，后者补索引。往这个名单里加，等于承认又漏了一个。
 */
const UNREACHABLE_BASELINE = new Set<string>([
  'collect_agent',
  'declare_deliverables',
  'diagnostics',
  'git_commit',
  'git_diff',
  'git_worktree',
  'kill_shell',
  'local_speech_to_text',
  'plan_review',
  'ppt_edit',
  'read_tool_result_archive',
  'request_directory',
  'SkillCreate',
  'space_create',
  'space_list',
  'space_query',
  'task_output',
  'teammate',
  'visual_edit',
]);

function collectRegisteredSchemas(): ToolSchema[] {
  const schemas: ToolSchema[] = [];
  registerMigratedTools(
    { register: (schema: ToolSchema) => { schemas.push(schema); } } as never,
    // darwin 是注册面的超集（connectors 全组仅 macOS 注册），用它扫才不会漏
    'darwin',
  );
  return schemas;
}

function makeReachabilityProbe() {
  const core = new Set(CORE_TOOLS);
  const service = new ToolSearchService();
  /** 模型 `select:<name>` 能不能拿到**它自己**（alias 串到别的工具不算） */
  const selectHitsItself = (name: string): boolean =>
    service.selectTool(name).tools[0]?.name === name;
  return {
    core,
    selectHitsItself,
    isDiscoverable: (name: string): boolean => core.has(name) || selectHitsItself(name),
  };
}

describe('注册即可发现（registry → 模型到达路径）', () => {
  it('每个注册工具都有到达路径，存量基线只许变短', () => {
    const { core, isDiscoverable } = makeReachabilityProbe();
    const schemas = collectRegisteredSchemas();

    // 防零目标假绿：注册表若因 import 变动扫成空/极少，下面的 toEqual([]) 会天然通过
    expect(schemas.length).toBeGreaterThan(100);

    const unreachable = schemas
      .map((schema) => schema.name)
      .filter((name) => !core.has(name))
      .filter((name) => !isDiscoverable(name))
      .filter((name) => !(name in REACHABLE_VIA_FACADE))
      .filter((name) => !STRICT_SKILL_INJECTED.has(name))
      .filter((name) => !UNREACHABLE_BASELINE.has(name));

    expect(unreachable).toEqual([]);
  });

  it('门面工具自身必须可发现（门面被删/改名/挪出索引则本门红）', () => {
    const { isDiscoverable } = makeReachabilityProbe();
    const brokenFacades = [...new Set(Object.values(REACHABLE_VIA_FACADE))]
      .filter((facade) => !isDiscoverable(facade));
    expect(brokenFacades).toEqual([]);
  });

  it('门面白名单里的子工具确实仍未单独可发现（补进索引后要从白名单删掉）', () => {
    const { selectHitsItself, core } = makeReachabilityProbe();
    const nowDiscoverable = Object.keys(REACHABLE_VIA_FACADE)
      .filter((name) => core.has(name) || selectHitsItself(name));
    expect(nowDiscoverable).toEqual([]);
  });

  it('存量基线里的名字确实仍不可达（修好后要从基线删掉）', () => {
    const { isDiscoverable } = makeReachabilityProbe();
    const alreadyFixed = [...UNREACHABLE_BASELINE].filter((name) => isDiscoverable(name));
    expect(alreadyFixed).toEqual([]);
  });

  it('基线与白名单里的名字都必须仍在注册表里（工具删了要同步清理）', () => {
    const registered = new Set(collectRegisteredSchemas().map((schema) => schema.name));
    const stale = [
      ...UNREACHABLE_BASELINE,
      ...Object.keys(REACHABLE_VIA_FACADE),
      ...STRICT_SKILL_INJECTED,
    ].filter((name) => !registered.has(name));
    expect(stale).toEqual([]);
  });

  it('STRICT_SKILL_INJECTED 里的工具确实仍被 strict skill 引用（最后一个引用消失时提醒清理）', () => {
    const strictSkillTools = new Set(
      BUILTIN_SKILLS.filter((skill) => skill.strictToolset).flatMap((skill) => skill.allowedTools ?? []),
    );
    const orphaned = [...STRICT_SKILL_INJECTED].filter((name) => !strictSkillTools.has(name));
    expect(orphaned).toEqual([]);
  });
});
