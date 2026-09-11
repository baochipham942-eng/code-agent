import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import {
  buildToolStatusLineCopy,
  isRawToolStdoutNoMatches,
  type ToolStatusLineInput,
} from '../../../src/renderer/utils/toolStatusLinePresentation';

/**
 * FB-114 four contradictory status-line words. Count unique members present
 * in the assembled copy — never more than one.
 */
const CONTRADICTORY_TERMINALS = ['已中断', '未成功', '未执行', '应用重启时中断'] as const;

function presentTerminals(text: string): string[] {
  return CONTRADICTORY_TERMINALS.filter((word) => text.includes(word));
}

function grepWeather(result?: ToolCall['result']): ToolCall {
  return {
    id: 'grep-weather',
    name: 'Grep',
    arguments: { pattern: 'weather' },
    result,
  };
}

function editDevNull(result?: ToolCall['result']): ToolCall {
  return {
    id: 'edit-dev-null',
    name: 'Edit',
    arguments: { file_path: '/dev/null' },
    result,
  };
}

describe('tool status line — 真实输入 → 唯一终态', () => {
  // 🔴 原来这里按 flags 组合穷举，但那些组合有一半在生产里不可达
  // （notExecuted 定义上蕴含 interrupted），等于在测一个比现实更大的空间；
  // 而 deriveToolStatusLineFlags / resolveToolStatusLineTerminal 只为这个测试而导出，
  // 被 knip 生产不可达棘轮判红。改成从公开入口 buildToolStatusLineCopy 喂真实输入，
  // 只覆盖真能出现的状态——过棘轮，也更贴生产。
  const placeholderError = '应用重启时中断';
  it.each([
    ['中断且没有结果', { status: 'interrupted' as const, result: undefined }, undefined, 'interrupted', '已中断'],
    ['中断且结果是中断占位', { status: 'interrupted' as const, result: { toolCallId: 'x', success: false, error: placeholderError } }, undefined, 'interrupted', '已中断'],
    ['中断且原因是应用重启', { status: 'interrupted' as const, result: undefined }, 'app-restart' as const, 'restart-interrupted', '应用重启时中断'],
    ['中断且带真实失败结果', { status: 'interrupted' as const, result: { toolCallId: 'x', success: false, error: 'boom' } }, undefined, 'interrupted', '已中断'],
    ['状态就是 error', { status: 'error' as const, result: undefined }, undefined, 'failed', '未成功'],
    ['结果 success=false', { status: 'success' as const, result: { toolCallId: 'x', success: false, error: 'boom' } }, undefined, 'failed', '未成功'],
  ])('%s → %s', (_name, patch, reason, expectedKey, expectedWord) => {
    const copy = buildToolStatusLineCopy(
      {
        toolCall: editDevNull(patch.result as never),
        status: patch.status,
        ...(reason ? { interruptionReason: reason } : {}),
      } as never,
      zh,
    );
    expect(copy.terminalKey).toBe(expectedKey);
    expect(presentTerminals(copy.terminal)).toEqual([expectedWord]);
  });

  it.each([
    [
      '已中断',
      {
        status: 'interrupted' as const,
        toolCall: grepWeather(),
      },
      '已中断',
    ],
    [
      '应用重启时中断',
      {
        status: 'interrupted' as const,
        interruptionReason: 'app-restart' as const,
        toolCall: grepWeather(),
      },
      '应用重启时中断',
    ],
    [
      '已中断+未成功',
      {
        status: 'interrupted' as const,
        toolCall: editDevNull({
          toolCallId: 'edit-dev-null',
          success: false,
          error: 'ENOENT',
        }),
      },
      '已中断',
    ],
    [
      '已中断+未执行',
      {
        status: 'interrupted' as const,
        toolCall: grepWeather(),
      },
      '已中断',
    ],
    [
      '已中断+应用重启时中断',
      {
        status: 'interrupted' as const,
        interruptionReason: 'app-restart' as const,
        toolCall: grepWeather(),
      },
      '应用重启时中断',
    ],
    [
      '未成功+未执行（占位失败当未执行）',
      {
        status: 'interrupted' as const,
        toolCall: editDevNull({
          toolCallId: 'edit-dev-null',
          success: false,
          error: '[no result: this tool call was cancelled before a result was recorded; do not assume it ran or succeeded]',
        }),
      },
      '已中断',
    ],
    [
      '未成功+应用重启时中断',
      {
        status: 'interrupted' as const,
        interruptionReason: 'app-restart' as const,
        toolCall: editDevNull({
          toolCallId: 'edit-dev-null',
          success: false,
          error: 'ENOENT',
        }),
      },
      '应用重启时中断',
    ],
    [
      '未执行+应用重启时中断',
      {
        status: 'interrupted' as const,
        interruptionReason: 'app-restart' as const,
        toolCall: grepWeather(),
      },
      '应用重启时中断',
    ],
    [
      'dogfood 四词同时为真',
      {
        status: 'interrupted' as const,
        interruptionReason: 'app-restart' as const,
        toolCall: grepWeather({
          toolCallId: 'grep-weather',
          success: false,
          error: '[no result: this tool call was cancelled before a result was recorded; do not assume it ran or succeeded]',
          output: 'No matches found',
        }),
      },
      '应用重启时中断',
    ],
  ] as const)('%s → 只有 %s', (_label, input, expected) => {
    const copy = buildToolStatusLineCopy(input as ToolStatusLineInput, zh);
    expect(presentTerminals(copy.line)).toEqual([expected]);
    expect(copy.line).not.toMatch(/No matches/i);
    expect(copy.action).not.toContain('未成功');
    expect(copy.action).not.toContain('未执行');
    expect(copy.action).not.toContain('已中断');
    expect(copy.action).not.toContain('应用重启时中断');
  });

  it('failed-only 动作短语可以带未成功，但仍只有这一个终态词', () => {
    const copy = buildToolStatusLineCopy({
      status: 'error',
      toolCall: editDevNull({
        toolCallId: 'edit-dev-null',
        success: false,
        error: 'ENOENT',
      }),
    }, zh);
    expect(presentTerminals(copy.line)).toEqual(['未成功']);
    expect(copy.action).toContain('未成功');
  });

  it('dogfood grep+重启：动作是搜索 weather，终态只有应用重启时中断', () => {
    const copy = buildToolStatusLineCopy({
      status: 'interrupted',
      interruptionReason: 'app-restart',
      toolCall: grepWeather({
        toolCallId: 'grep-weather',
        success: true,
        output: 'No matches found',
      }),
    }, zh);
    expect(copy.terminalKey).toBe('restart-interrupted');
    expect(copy.line).toBe('应用重启时中断 · 搜索 weather');
    expect(presentTerminals(copy.line)).toEqual(['应用重启时中断']);
    // 原来这里再断言一遍内部 flags；内部件已不再导出（生产不可达），
    // 而 terminalKey='restart-interrupted' 本身就唯一对应那组 flags，断言等价。
  });

  it('dogfood edit /dev/null+重启：动作不含未成功', () => {
    const copy = buildToolStatusLineCopy({
      status: 'interrupted',
      interruptionReason: 'app-restart',
      toolCall: editDevNull({
        toolCallId: 'edit-dev-null',
        success: false,
        error: 'ENOENT',
      }),
    }, zh);
    expect(copy.line).toBe('应用重启时中断 · 编辑 /dev/null');
    expect(presentTerminals(copy.line)).toEqual(['应用重启时中断']);
  });
});

describe('collapsed tool stdout', () => {
  it('recognizes grep/glob empty stdout and localizes it', () => {
    expect(isRawToolStdoutNoMatches('No matches')).toBe(true);
    expect(isRawToolStdoutNoMatches('No matches found')).toBe(true);
    expect(isRawToolStdoutNoMatches('No files matched the pattern')).toBe(true);
  });
});
