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
  // ai-review #1693：「无匹配」不能用 includes 在正文里找子串——一个名叫
  // `No matches.md` 的文件被 Glob 找到时，子串判定会把有结果说成无结果。
  it('Glob 找到名含 No matches 的文件时不得报「无匹配」', () => {
    const hit: ToolCall = {
      id: 'glob-hit',
      name: 'Glob',
      arguments: { pattern: 'docs/**' },
      result: {
        toolCallId: 'glob-hit',
        success: true,
        output: 'docs/No matches.md\n\nnextOffset: null',
      },
    };
    expect(getToolStatusLabel(hit, 'success', zh)).not.toBe(zh.toolStatus.grepNoMatches);

    const empty: ToolCall = {
      ...hit,
      id: 'glob-empty',
      result: { toolCallId: 'glob-empty', success: true, output: 'No matches found' },
    };
    expect(getToolStatusLabel(empty, 'success', zh)).toBe(zh.toolStatus.grepNoMatches);
  });

  it('reports spawn completion according to foreground versus background facts', () => {
    const foreground: ToolCall = {
      id: 'spawn-foreground',
      name: 'spawn_agent',
      arguments: { task: '核对清单' },
      result: { toolCallId: 'spawn-foreground', success: true, output: '- Agent ID: agent-1\nResult: done' },
    };
    const background: ToolCall = {
      ...foreground,
      id: 'spawn-background',
      result: {
        toolCallId: 'spawn-background',
        success: true,
        output: 'spawned in background\n- Agent ID: agent-2\n- Status: running',
      },
    };

    expect(getToolStatusLabel(foreground, 'success', zh)).toBe('已完成');
    expect(getToolStatusLabel(background, 'success', zh)).toBe('已派出');
  });

  it('写后验收失败也只使用共享终态，不再拼局部终态词', () => {
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

    const outcome = zh.outcomeWords['failed-tool'].timeline;
    expect(label).toBe(`${outcome.label} · ${zh.toolErrors.artifactValidation.detail}`);
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

    const outcome = zh.outcomeWords['failed-tool'].timeline;
    expect(label).toBe(`${outcome.label} · ${zh.toolStepHumanize.failureReasonMissing}`);
  });

  it('maps an explicit approval denial to the shared terminal word and reason', () => {
    const label = getToolStatusLabel(
      makeWriteCall({
        result: {
          toolCallId: 'write-1',
          success: false,
          error: 'Permission denied',
          metadata: { code: 'PERMISSION_DENIED' },
        },
      }),
      'error',
      zh,
    );
    const outcome = zh.outcomeWords['failed-approval-denied'].timeline;

    expect(label).toBe(`${outcome.label} · ${outcome.reason}`);
  });

  it('maps metadata timeout to the shared timeout terminal word and concrete reason', () => {
    const label = getToolStatusLabel(
      makeWriteCall({
        result: {
          toolCallId: 'write-1',
          success: false,
          error: 'Timed out',
          metadata: { failureCode: 'timeout' },
        },
      }),
      'error',
      zh,
    );
    const outcome = zh.outcomeWords['failed-timeout'].timeline;

    expect(label).toBe(`${outcome.label} · ${outcome.reason}`);
  });

  it('maps a raw timeout error to the same shared timeout outcome', () => {
    const label = getToolStatusLabel(
      makeWriteCall({
        result: { toolCallId: 'write-1', success: false, error: 'Request timed out after 30s' },
      }),
      'error',
      zh,
    );
    const outcome = zh.outcomeWords['failed-timeout'].timeline;

    expect(label).toBe(`${outcome.label} · ${zh.toolErrors.timeout.detail}`);
  });

  // host 验收门（toolArtifactRepairPolicy.isFileMutationTool）覆盖的不只 Write：
  // Edit/edit_file/append_file/Append 写后验收失败同样被翻转成 success=false +
  // metadata.artifactValidation.failed，状态词不能错报成「编辑失败」。
  it('Edit 写后验收失败使用共享终态', () => {
    const label = getToolStatusLabel(makeMutationCall('Edit'), 'error', zh);

    const outcome = zh.outcomeWords['failed-tool'].timeline;
    expect(label).toBe(`${outcome.label} · ${zh.toolErrors.artifactValidation.detail}`);
  });

  it('edit_file 写后验收失败使用共享终态', () => {
    const label = getToolStatusLabel(makeMutationCall('edit_file'), 'error', zh);

    const outcome = zh.outcomeWords['failed-tool'].timeline;
    expect(label).toBe(`${outcome.label} · ${zh.toolErrors.artifactValidation.detail}`);
  });

  it('append_file 写后验收失败使用共享终态', () => {
    const label = getToolStatusLabel(makeMutationCall('append_file'), 'error', zh);

    const outcome = zh.outcomeWords['failed-tool'].timeline;
    expect(label).toBe(`${outcome.label} · ${zh.toolErrors.artifactValidation.detail}`);
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

    const outcome = zh.outcomeWords['failed-tool'].timeline;
    expect(label).toBe(`${outcome.label} · ${zh.toolStepHumanize.failureReasonMissing}`);
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
