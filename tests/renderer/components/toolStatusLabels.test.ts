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
  // ai-review #1693：「有没有匹配」只认结构化 totalMatches，绝不解析正文。
  // 三轮各造出一个正文反例：docs/No matches.md（子串）、No files matched the pattern
  // （整行全等漏真阳）、根目录 No files matched.md（首词前缀）。文件名能构造，计数不能。
  const globCall = (output: string, metadata?: Record<string, unknown>): ToolCall => ({
    id: 'glob-x',
    name: 'Glob',
    arguments: { pattern: '**' },
    result: { toolCallId: 'glob-x', success: true, output, ...(metadata ? { metadata } : {}) },
  });

  it('totalMatches=0 才报「无匹配」', () => {
    expect(getToolStatusLabel(globCall('No files matched the pattern', { totalMatches: 0 }), 'success', zh))
      .toBe(zh.toolStatus.grepNoMatches);
  });

  it.each([
    ['docs/No matches.md\n\nnextOffset: null'],
    ['No files matched.md\n\nnextOffset: null'],
  ])('找到名字长得像空结果标记的文件（%s）不得报「无匹配」', (output) => {
    expect(getToolStatusLabel(globCall(output, { totalMatches: 1 }), 'success', zh))
      .not.toBe(zh.toolStatus.grepNoMatches);
  });

  it('拿不到 totalMatches 时什么都不说，不猜', () => {
    expect(getToolStatusLabel(globCall('No files matched the pattern'), 'success', zh))
      .not.toBe(zh.toolStatus.grepNoMatches);
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

// ai-review #1693 第三轮②：删空匹配摘要只对 Grep/Glob 成立——它们的状态行会替它说
// 「无匹配」。别的工具（mcp__github__search_code 等）状态行不产出这句，删掉摘要后
// 折叠行只剩动作名，用户看不出找没找到。
describe('折叠行摘要的隐藏范围', () => {
  it('只有 Grep/Glob 的空结果摘要被状态行接管', async () => {
    const { collapsedSuccessSummaryForTest } = await import(
      '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ResultSummary'
    );
    const call = (name: string, metadata?: Record<string, unknown>): ToolCall => ({
      id: `${name}-x`,
      name,
      arguments: {},
      result: { toolCallId: `${name}-x`, success: true, output: 'No matches found', ...(metadata ? { metadata } : {}) },
    });
    expect(collapsedSuccessSummaryForTest('No matches found', call('Glob', { totalMatches: 0 }))).toBeNull();
    expect(collapsedSuccessSummaryForTest('No matches found', call('Grep', { totalMatches: 0 }))).toBeNull();
    expect(collapsedSuccessSummaryForTest('No matches found', call('mcp__github__search_code', { totalMatches: 0 })))
      .toBe('No matches found');
    // 状态行没接管（拿不到计数）时不许删摘要，否则折叠行一个字都没有
    expect(collapsedSuccessSummaryForTest('No matches found', call('Glob'))).toBe('No matches found');
  });
});
