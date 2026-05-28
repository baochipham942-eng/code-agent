import { describe, expect, it } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { buildTurnFileChanges } from '../../../src/renderer/utils/turnDiffSummary';

function turnWithWrite(args: Record<string, unknown>, result = 'Created file: /x/index.html'): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 100,
    endTime: 140,
    nodes: [
      {
        id: 'tool-1',
        type: 'tool_call',
        content: '',
        timestamp: 130,
        toolCall: { id: 'tool-1', name: 'Write', args, result, success: true },
      },
    ],
  } satisfies TraceTurn;
}

describe('buildTurnFileChanges — Bug 1: diff line count on truncated Write content', () => {
  it('uses authoritative content_lines when content was truncated to a fragment', () => {
    // 模拟事件流里被 sanitize 压成片段的 Write：content 是片段，content_lines 是真实行数
    const change = buildTurnFileChanges(
      turnWithWrite({
        file_path: '/x/index.html',
        content: '<!DOCTYPE html>...[1800 chars omitted]...</html>',
        content_length: 1850,
        content_lines: 142,
      }),
    )[0];

    expect(change.filePath).toBe('/x/index.html');
    expect(change.isNewFile).toBe(true);
    // 关键：用 142（权威行数），不是对片段 diff 出的 ~2 行
    expect(change.added).toBe(142);
    expect(change.removed).toBe(0);
  });

  it('falls back to diffing full content when not truncated (no content_lines)', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const change = buildTurnFileChanges(
      turnWithWrite({ file_path: '/x/small.html', content }),
    )[0];

    expect(change.added).toBe(5);
    expect(change.removed).toBe(0);
  });
});
