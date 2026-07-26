// ============================================================================
// 错误摘要不得把模型面向的 <tool-args-validation-error> 裸标签怼给用户
// （2026-07-27 dogfood：语音派发 run 的校验失败在消息流里渲染出红色裸标签行）
// ============================================================================

import { describe, it, expect } from 'vitest';
import { summarizeTool } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/summarizers';
import type { ToolCall } from '../../../src/shared/contract/tool';

function makeCall(error: string): ToolCall {
  return {
    id: 'tc-1',
    name: 'Write',
    arguments: { file_path: '/work/test3.txt' },
    result: { toolCallId: 'tc-1', success: false, error },
  } as ToolCall;
}

describe('summarizeTool error line', () => {
  it('跳过 XML 包裹标签行，取第一行人话', () => {
    const summary = summarizeTool(makeCall(
      '<tool-args-validation-error>\n工具 "Write" 参数校验失败（1 处问题）：\n  - 缺少必填参数 `content`\n</tool-args-validation-error>',
    ));
    expect(summary).toContain('参数校验失败');
    expect(summary).not.toContain('<tool-args-validation-error>');
  });

  it('普通错误仍取第一行', () => {
    expect(summarizeTool(makeCall('ENOENT: no such file\nstack...'))).toContain('ENOENT');
  });
});
