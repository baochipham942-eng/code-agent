import { describe, expect, it } from 'vitest';
import { getToolStatusLabel } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/statusLabels';
import type { ToolCall } from '../../../src/shared/contract';

function bash(output: string, metadata?: Record<string, unknown>): ToolCall {
  return {
    id: 'b1',
    name: 'Bash',
    arguments: { command: 'make' },
    result: { toolCallId: 'b1', success: true, output, metadata },
  };
}

describe('getToolStatusLabel — Bash exit code (P0 #4：去矛盾)', () => {
  it('success 态非零退出码：中性展示退出码，不再说「可能不可靠」（成功≠不可靠，自相矛盾）', () => {
    const label = getToolStatusLabel(bash('build output', { exitCode: 2 }), 'success');
    expect(label).toContain('退出码 2'); // 保留信息：仍把退出码 surface 出来
    expect(label).not.toContain('不可靠'); // 去掉与 success 自相矛盾的「判定可能不可靠」
  });

  it('keeps the clean label when exit code is 0', () => {
    const label = getToolStatusLabel(bash('ok', { exitCode: 0 }), 'success');
    expect(label).not.toContain('退出码');
  });

  it('keeps the clean label when exit code is unknown', () => {
    const label = getToolStatusLabel(bash('ok'), 'success');
    expect(label).not.toContain('退出码');
  });

  it('does not affect non-bash tools', () => {
    const grep: ToolCall = {
      id: 'g1',
      name: 'Grep',
      arguments: { pattern: 'x' },
      result: { toolCallId: 'g1', success: true, output: '3 matches', metadata: { exitCode: 1 } },
    };
    expect(getToolStatusLabel(grep, 'success')).toBe('找到 3 处匹配');
  });
});
