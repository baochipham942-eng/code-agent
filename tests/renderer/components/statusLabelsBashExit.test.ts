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

describe('getToolStatusLabel — Bash exit code (UX③)', () => {
  it('surfaces a non-zero exit code on a success-labeled bash result', () => {
    const label = getToolStatusLabel(bash('build output', { exitCode: 2 }), 'success');
    expect(label).toContain('退出码 2');
    expect(label).toContain('判定可能不可靠');
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
