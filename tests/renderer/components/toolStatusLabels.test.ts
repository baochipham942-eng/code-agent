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

function makeMutationCall(name: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: `${name}-1`,
    name,
    arguments: { file_path: '/tmp/game.html' },
    result: {
      toolCallId: `${name}-1`,
      success: false,
      error: 'Artifact validation failed for /tmp/game.html.',
      metadata: {
        artifactValidation: {
          failed: true,
        },
      },
    },
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

  // host 验收门（toolArtifactRepairPolicy.isFileMutationTool）覆盖的不只 Write：
  // Edit/edit_file/append_file/Append 写后验收失败同样被翻转成 success=false +
  // metadata.artifactValidation.failed，状态词不能错报成「编辑失败」。
  it('distinguishes artifact validation failure after a successful Edit', () => {
    const label = getToolStatusLabel(makeMutationCall('Edit'), 'error', zh);

    expect(label).toBe('已编辑，验收失败');
  });

  it('distinguishes artifact validation failure after a successful edit_file', () => {
    const label = getToolStatusLabel(makeMutationCall('edit_file'), 'error', zh);

    expect(label).toBe('已编辑，验收失败');
  });

  it('distinguishes artifact validation failure after a successful append_file', () => {
    const label = getToolStatusLabel(makeMutationCall('append_file'), 'error', zh);

    expect(label).toBe('已追加，验收失败');
  });

  it('keeps the normal Edit failure label for actual edit failures', () => {
    const label = getToolStatusLabel(
      makeMutationCall('Edit', {
        result: {
          toolCallId: 'Edit-1',
          success: false,
          error: 'old_string not found',
        },
      }),
      'error',
      zh,
    );

    expect(label).toBe('编辑失败');
  });

  // 步骤行主文案本身就是一句过去时人话（「写入了 notes.md」），成功态再前置一个
  // 「已创建」就是同一个动词讲两遍，成败已由左侧 StatusIndicator 表达。
  it('成功且无结果数据时不给状态词，避免与主文案的动词重复', () => {
    const label = getToolStatusLabel(
      makeWriteCall({
        result: { toolCallId: 'write-1', success: true, output: 'Created file: /tmp/game.html' },
      }),
      'success',
      zh,
    );

    expect(label).toBeNull();
  });

  it('成功且带结果数据时仍报数据——那不是重复动词而是新信息', () => {
    const label = getToolStatusLabel(
      {
        id: 'grep-1',
        name: 'Grep',
        arguments: { pattern: 'TODO' },
        result: { toolCallId: 'grep-1', success: true, output: 'Found 3 matches' },
      },
      'success',
      zh,
    );

    expect(label).toBe('找到 3 处匹配');
  });
});
