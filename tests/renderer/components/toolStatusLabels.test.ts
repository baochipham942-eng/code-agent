import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { getToolStatusLabel } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/statusLabels';
import { zh } from '../../../src/renderer/i18n/zh';

function makeWriteCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'write-1',
    name: 'Write',
    arguments: { file_path: '/tmp/game.html' },
    ...overrides,
  };
}

describe('ToolCallDisplay status labels', () => {
  it('distinguishes artifact validation failure after a successful file write', () => {
    const label = getToolStatusLabel(
      makeWriteCall({
        result: {
          toolCallId: 'write-1',
          success: false,
          error: 'Artifact validation failed for /tmp/game.html.',
          metadata: {
            artifactValidation: {
              failed: true,
            },
          },
        },
      }),
      'error',
      zh,    );

    expect(label).toBe('已写入，验收失败');
  });

  it('keeps the normal Write failure label for actual write failures', () => {
    const label = getToolStatusLabel(
      makeWriteCall({
        result: {
          toolCallId: 'write-1',
          success: false,
          error: 'EACCES: permission denied',
        },
      }),
      'error',
      zh,    );

    expect(label).toBe('写入失败');
  });
});
