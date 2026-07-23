// ============================================================================
// 内置 skill 声明的工具必须是「模型真找得到」的 —— 防复发门
// ----------------------------------------------------------------------------
// 2026-07-23 实测事故：新工具 list_experts 在协议注册表里注册了、typecheck 与全量
// 15270 条测试全绿，但**没进 DEFERRED_TOOLS_META**，于是 ToolSearchService 报
// "Tool not found: list_experts"，模型找不到就退回 Bash 去 glob 文件系统猜角色。
//
// 判据：非 strict skill 的工具要靠 ToolSearch 发现，所以它 allowedTools 里的每个名字
// （经 TOOL_ALIASES 解析后）必须落在 CORE_TOOLS ∪ DEFERRED_TOOLS_META 里。
// strict skill 的工具集是直接注入的，不走 ToolSearch，故不在本门范围内。
//
// 门的盲区自陈：
//  1) 只管内置 skill，管不到用户自建 skill 的 tools 字段（那条链路本仓仍无权威校验）
//  2) 只管"发现得到"，不管"调用真能成"（权限/参数问题另有其门）
//  3) 下面的 KNOWN_UNDISCOVERABLE 是**存量基线**，只许变短不许变长
// ============================================================================

import { describe, expect, it } from 'vitest';
import { CORE_TOOLS, DEFERRED_TOOLS_META, resolveToolAlias } from '../../../../src/host/services/toolSearch/deferredTools';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkillsData';

/**
 * 存量未登记名单（**只许变短**）。
 *
 * 2026-07-23 建门时 6 条；同日清掉 5 条——read_xlsx / read_pdf / http_request 在 tools/modules 下，
 * ocr_search / photo_archive 在 plugins/builtin 下，都是真工具，只是漏了发现索引。
 *
 * 剩下的 `memory_search` 是**真空，不是漏登记**：全仓没有这个工具，它只作为 `memory` 那条 meta 的
 * alias 字符串存在，而 `memory` 本身也没有同名 protocol tool（真实记忆工具是 MemoryRead /
 * MemoryWrite / EpisodicRecall，没有一个能按文本搜 memories 表）。引用方不止这两个 skill——
 * `ocr_search` 插件的描述里也写着"再用 memory_search 检索"。要么补一个搜 memories 表的工具，
 * 要么改写这三处文案，属产品决策，待拍板后再清。
 */
const KNOWN_UNDISCOVERABLE = new Set([
  'memory_search',
]);

function discoverableToolNames(): Set<string> {
  return new Set([...CORE_TOOLS, ...DEFERRED_TOOLS_META.map((meta) => meta.name)]);
}

describe('内置 skill 声明的工具可被模型发现', () => {
  it('非 strict skill 的 allowedTools 全部可通过 ToolSearch 发现（存量白名单只许变短）', () => {
    const discoverable = discoverableToolNames();
    const offenders: string[] = [];

    for (const skill of BUILTIN_SKILLS) {
      if (skill.strictToolset) continue;
      for (const tool of skill.allowedTools ?? []) {
        if (discoverable.has(resolveToolAlias(tool))) continue;
        if (KNOWN_UNDISCOVERABLE.has(tool)) continue;
        offenders.push(`${skill.name} → ${tool}`);
      }
    }

    // 先确认扫到了东西，避免"零目标"时这条断言天然通过（假绿）
    expect(BUILTIN_SKILLS.filter((skill) => !skill.strictToolset).length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it('存量白名单里的名字确实仍未登记（清理干净后要把它从白名单删掉）', () => {
    const discoverable = discoverableToolNames();
    const alreadyFixed = [...KNOWN_UNDISCOVERABLE].filter((tool) => discoverable.has(resolveToolAlias(tool)));
    expect(alreadyFixed).toEqual([]);
  });

  it('list_experts 已进发现索引（本次事故的回归钉）', () => {
    expect(discoverableToolNames().has('list_experts')).toBe(true);
  });
});
