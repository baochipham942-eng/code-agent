import { describe, expect, it } from 'vitest';
import { isUnattendedAllowedReadOnlyTool } from '../../../src/host/permissions/unattendedReadOnlyTools';
import { FEISHU_READONLY_TOOLS } from '../../../src/shared/constants/feishu';

describe('isUnattendedAllowedReadOnlyTool', () => {
  it('放行飞书 catalog 声明的全部 6 个只读工具（运行时 mcp__lark__ 名）', () => {
    for (const bare of FEISHU_READONLY_TOOLS) {
      const runtime = `mcp__lark__${bare.replace(/\./g, '_')}`;
      expect(isUnattendedAllowedReadOnlyTool(runtime)).toBe(true);
    }
    // 抽一个具体的确认映射正确
    expect(isUnattendedAllowedReadOnlyTool('mcp__lark__calendar_v4_calendarEvent_list')).toBe(true);
  });

  it('非 MCP 工具一律不走这条路（各有各的审批规则）', () => {
    for (const tool of ['bash', 'write', 'edit', 'read_file', 'web_search']) {
      expect(isUnattendedAllowedReadOnlyTool(tool)).toBe(false);
    }
  });

  it('未知 server 的 MCP 工具不放行', () => {
    expect(isUnattendedAllowedReadOnlyTool('mcp__unknownserver__do_stuff')).toBe(false);
    expect(isUnattendedAllowedReadOnlyTool('mcp__memory_kv__kv_list')).toBe(false);
  });

  it('【安全变异】lark 前缀下、但未在声明只读集里的工具（含伪写工具）必须仍拒绝', () => {
    // 这些 bitable 写操作不在 FEISHU_READONLY_TOOLS 里；即使套上可信 lark 前缀也不能提权。
    // LARK_TOOLS 已锁死 server 只暴露只读集，这层是纵深防御：万一名字被构造出来也放不进去。
    expect(isUnattendedAllowedReadOnlyTool('mcp__lark__bitable_v1_appTableRecord_create')).toBe(false);
    expect(isUnattendedAllowedReadOnlyTool('mcp__lark__bitable_v1_appTableRecord_update')).toBe(false);
    expect(isUnattendedAllowedReadOnlyTool('mcp__lark__im_v1_message_create')).toBe(false);
    // 确认这些没混进声明集（否则上面的断言是假绿）
    expect(FEISHU_READONLY_TOOLS).not.toContain('bitable.v1.appTableRecord.create');
  });

  it('空串 / 垃圾输入不放行', () => {
    expect(isUnattendedAllowedReadOnlyTool('')).toBe(false);
    expect(isUnattendedAllowedReadOnlyTool('mcp__')).toBe(false);
    expect(isUnattendedAllowedReadOnlyTool('mcp__lark__')).toBe(false);
  });
});
