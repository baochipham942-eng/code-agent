// ============================================================================
// targetContext 渲染端推导
// ============================================================================
// 表驱动：往 EXPECTED 里加一行就多一条用例。底线两条在最后，别删。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { deriveToolTargetContext } from '../../../src/renderer/utils/humanizeToolStep';

interface Row {
  name: string;
  args?: Record<string, unknown>;
  kind: 'file' | 'browser' | 'mcp_server' | 'memory' | undefined;
  label?: string;
}

// 覆盖面口径：2026-07 起真库 5357 次调用里 browser 36.9% / file 27.0% /
// mcp_server 0.5%，其余 35.5% 无图标。下面按真实调用量从高到低取样。
const EXPECTED: Row[] = [
  // —— browser ——
  { name: 'WebSearch', args: { query: 'claude code' }, kind: 'browser' },
  { name: 'WebFetch', args: { url: 'https://docs.anthropic.com/en/api' }, kind: 'browser', label: 'docs.anthropic.com' },
  { name: 'WebFetch', args: { url: '不是个 URL' }, kind: 'browser' },
  { name: 'screenshot_page', args: {}, kind: 'browser' },
  { name: 'browser_action', args: {}, kind: 'browser' },

  // —— file ——
  { name: 'Read', args: { file_path: '/a/b/MEMORY.md' }, kind: 'file', label: 'MEMORY.md' },
  { name: 'Write', args: { file_path: '/tmp/out.ts' }, kind: 'file', label: 'out.ts' },
  { name: 'Edit', args: { file_path: 'src/index.ts' }, kind: 'file', label: 'index.ts' },
  { name: 'Grep', args: { pattern: 'foo' }, kind: 'file', label: 'foo' },
  { name: 'Glob', args: { pattern: '**/*.ts' }, kind: 'file', label: '*.ts' },
  { name: 'list_directory', args: { path: '/a/b' }, kind: 'file', label: 'b' },
  { name: 'Read', args: {}, kind: 'file' },

  // —— mcp_server ——
  { name: 'mcp__lark__calendar_v4_calendarEvent_list', args: {}, kind: 'mcp_server', label: 'lark' },
  { name: 'mcp_exa_search', args: {}, kind: 'mcp_server', label: 'exa' },

  // —— memory ——
  { name: 'memory_store', args: {}, kind: 'memory' },
  { name: 'memory_search', args: {}, kind: 'memory' },

  // —— 明确「无目标」：模型今天在这些上填的 kind 全是瞎猜 ——
  { name: 'Bash', args: { command: 'ls -la' }, kind: undefined },
  { name: 'AskUserQuestion', args: {}, kind: undefined },
  { name: 'ToolSearch', args: {}, kind: undefined },
  { name: 'spawn_agent', args: {}, kind: undefined },
  { name: 'TaskManager', args: {}, kind: undefined },
  { name: 'Skill', args: {}, kind: undefined },
  { name: 'todo_write', args: {}, kind: undefined },
];

describe('deriveToolTargetContext', () => {
  for (const row of EXPECTED) {
    const suffix = row.kind ? `→ ${row.kind}${row.label ? ` (${row.label})` : ''}` : '→ 无图标';
    it(`${row.name} ${suffix}`, () => {
      const derived = deriveToolTargetContext(row.name, row.args);
      if (row.kind === undefined) {
        expect(derived).toBeUndefined();
        return;
      }
      expect(derived?.kind).toBe(row.kind);
      if (row.label !== undefined) expect(derived?.label).toBe(row.label);
    });
  }

  // ------------------------------------------------------------------
  // 底线两条：别删
  // ------------------------------------------------------------------

  it('底线①：未登记的工具推不出 kind，不许兜底成某个默认值', () => {
    // TargetContextIcon 对未知 kind 会渲染一个 MessageCircle 兜底图标——所以
    // 这里返回 undefined 而不是 { kind: 'unknown' } 才是对的，否则每个没登记的
    // 工具都会长出一个"聊天气泡"图标。
    expect(deriveToolTargetContext('SomeBrandNewTool2099', { whatever: 1 })).toBeUndefined();
    expect(deriveToolTargetContext('', undefined)).toBeUndefined();
  });

  it('底线②：宿主已推的 app kind 不归这里管（cua 的真 app logo 靠 bundleId）', () => {
    // computer_use 走 cuaNarration 在宿主侧推 { kind:'app', iconHint:bundleId }，
    // 渲染端拿不到 AX 树缓存，推不出 bundleId，抢着推只会把真 app logo 降级成
    // 一个 Monitor 通用图标。ToolHeader 的 `toolCall.targetContext ?? derive(...)`
    // 顺序保证宿主值优先，这里必须不产出 app。
    expect(deriveToolTargetContext('computer_use', {})?.kind).not.toBe('app');
  });
});
