// ============================================================================
// 组头摘要去重（P0 #1）：单个失败工具的错误文本不在组头重复（只由工具 cell 单处渲染），
// 多工具计数 / 单工具成功摘要保留。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { buildToolGroupHeadSummary } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import type { ToolCall } from '../../../src/shared/contract';

function tc(over: Partial<ToolCall> & Pick<ToolCall, 'name'>): ToolCall {
  return { id: Math.random().toString(36).slice(2), arguments: {}, ...over };
}

describe('buildToolGroupHeadSummary（P0 #1 组头去重）', () => {
  it('单个失败工具 → null（错误只在下方 cell 渲染，组头不重复错误首行）', () => {
    const failed = tc({
      name: 'Bash',
      result: { toolCallId: 'x', success: false, error: 'boom: command not found\n  at line 3\n  stack...' },
    });
    expect(buildToolGroupHeadSummary([failed])).toBeNull();
  });

  it('单个成功工具 → 保留结果摘要（非 null）', () => {
    const ok = tc({
      name: 'Read',
      result: { toolCallId: 'y', success: true, output: 'line1\nline2\nline3', metadata: { lines: 3 } },
    });
    // summarizeTool 对成功 Read 给「已读取 N 行」类摘要——这里只断言保留（非 null），不耦合具体文案
    expect(buildToolGroupHeadSummary([ok])).not.toBeNull();
  });

  it('多工具 → 计数摘要（含 "failed"），不展开任一条错误文本', () => {
    const failed = tc({ name: 'Bash', result: { toolCallId: 'a', success: false, error: '某条很长的错误堆栈……' } });
    const ok = tc({ name: 'Bash', result: { toolCallId: 'b', success: true, output: 'done' } });
    const summary = buildToolGroupHeadSummary([failed, ok]);
    expect(summary).toContain('failed');
    expect(summary).not.toContain('错误堆栈'); // 不重复具体错误文本
  });

  it('空数组 → null', () => {
    expect(buildToolGroupHeadSummary([])).toBeNull();
  });

  it('单个无结果工具 → null', () => {
    expect(buildToolGroupHeadSummary([tc({ name: 'Bash' })])).toBeNull();
  });
});
