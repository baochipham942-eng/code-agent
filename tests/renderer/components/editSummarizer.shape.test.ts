// ============================================================================
// N-EDIT-RETRY-KEY-SHAPE — summarizeEdit 必须认注册的 Edit 参数形状
// （file_path + edits[{old_text,new_text}]，见 multiEdit.schema.ts），
// 走公开入口 summarizeTool 验证，不直接 import 私有 summarizer。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { summarizeTool } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/summarizers';

function editToolCall(id: string, edits: Array<{ old_text: string; new_text: string }>): ToolCall {
  return {
    id,
    name: 'Edit',
    arguments: { file_path: '/src/app.ts', edits },
    result: { toolCallId: id, success: true, output: 'Edited /src/app.ts: 1 edit(s) applied.' },
  };
}

describe('summarizeTool — Edit summaries read the registered edits[] shape', () => {
  it('shows the line delta for a real edits[] Edit call', () => {
    expect(
      summarizeTool(editToolCall('tc-1', [{ old_text: 'line1\nline2', new_text: 'line1\nline2\nline3\nline4' }])),
    ).toBe('+2 lines');
  });

  it('aggregates the joined line delta across multi-item edits[]', () => {
    expect(
      summarizeTool(editToolCall('tc-2', [
        { old_text: 'a', new_text: 'a\nb\nc' },
        { old_text: 'x\ny', new_text: 'x\ny' },
      ])),
    ).toBe('+2 lines');
  });

  it('reports 无变化 when every edits[] item is a no-op', () => {
    expect(
      summarizeTool(editToolCall('tc-3', [{ old_text: 'same', new_text: 'same' }])),
    ).toBe('无变化');
  });
});
