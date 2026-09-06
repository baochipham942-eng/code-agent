import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import {
  buildToolStatusLineCopy,
  deriveToolStatusLineFlags,
  formatToolStatusLineTerminal,
  isRawToolStdoutNoMatches,
  localizeCollapsedToolSummary,
  resolveToolStatusLineTerminal,
  type ToolStatusLineFlags,
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

describe('tool status line — 状态输入组合 → 呈现文案', () => {
  it.each([
    [{ interrupted: true, failed: false, notExecuted: false, restartInterrupted: false }, undefined, 'interrupted', '已中断'],
    [{ interrupted: false, failed: true, notExecuted: false, restartInterrupted: false }, undefined, 'failed', '未成功'],
    [{ interrupted: false, failed: false, notExecuted: true, restartInterrupted: false }, undefined, 'not-executed', '未执行'],
    [{ interrupted: false, failed: false, notExecuted: false, restartInterrupted: true }, 'app-restart', 'restart-interrupted', '应用重启时中断'],
    [{ interrupted: true, failed: true, notExecuted: false, restartInterrupted: false }, undefined, 'interrupted', '已中断'],
    [{ interrupted: true, failed: false, notExecuted: true, restartInterrupted: false }, undefined, 'interrupted', '已中断'],
    [{ interrupted: true, failed: false, notExecuted: false, restartInterrupted: true }, 'app-restart', 'restart-interrupted', '应用重启时中断'],
    [{ interrupted: false, failed: true, notExecuted: true, restartInterrupted: false }, undefined, 'not-executed', '未执行'],
    [{ interrupted: false, failed: true, notExecuted: false, restartInterrupted: true }, 'app-restart', 'restart-interrupted', '应用重启时中断'],
    [{ interrupted: false, failed: false, notExecuted: true, restartInterrupted: true }, 'app-restart', 'restart-interrupted', '应用重启时中断'],
    [{ interrupted: true, failed: true, notExecuted: true, restartInterrupted: true }, 'app-restart', 'restart-interrupted', '应用重启时中断'],
  ] as const)(
    'flags %j → %s / %s',
    (flags, reason, expectedKey, expected) => {
      const key = resolveToolStatusLineTerminal(flags as ToolStatusLineFlags);
      expect(key).toBe(expectedKey);
      const word = formatToolStatusLineTerminal(key, zh, reason);
      expect(presentTerminals(word)).toEqual([expected]);
    },
  );

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
    expect(deriveToolStatusLineFlags({
      status: 'interrupted',
      interruptionReason: 'app-restart',
      toolCall: grepWeather({
        toolCallId: 'grep-weather',
        success: true,
        output: 'No matches found',
      }),
    })).toEqual({
      interrupted: true,
      failed: false,
      notExecuted: false,
      restartInterrupted: true,
    });
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
    expect(localizeCollapsedToolSummary('No matches', zh)).toBe('无匹配');
    expect(localizeCollapsedToolSummary('Found 3 results', zh)).toBe('Found 3 results');
  });
});
