// ============================================================================
// tui-app/shellOutput.ts — shell 输出截断展示（前 2 + 后 3）单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import { shellOutputPreview } from '../../../../src/cli/tui-app/shellOutput';

describe('shellOutputPreview', () => {
  it('空输出 / 全空白输出返回 undefined', () => {
    expect(shellOutputPreview('')).toBeUndefined();
    expect(shellOutputPreview('\n\n  \n')).toBeUndefined();
  });

  it('≤ 5 行全量返回（不插省略标记）', () => {
    expect(shellOutputPreview('a\nb')).toEqual(['a', 'b']);
    expect(shellOutputPreview('1\n2\n3\n4\n5')).toEqual(['1', '2', '3', '4', '5']);
  });

  it('> 5 行截断为前 2 + 省略标记 + 后 3', () => {
    const output = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    expect(shellOutputPreview(output)).toEqual([
      'line1',
      'line2',
      '… (5 more lines)',
      'line8',
      'line9',
      'line10',
    ]);
  });

  it('尾部空行先剥离再判断（命令输出普遍以 \\n 收尾）', () => {
    expect(shellOutputPreview('a\nb\n')).toEqual(['a', 'b']);
    const output = '1\n2\n3\n4\n5\n6\n\n\n';
    expect(shellOutputPreview(output)).toEqual(['1', '2', '… (1 more line)', '4', '5', '6']);
  });

  it('CRLF / 孤 CR 归一化为 LF', () => {
    expect(shellOutputPreview('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
  });

  it('省略 1 行时用单数 line', () => {
    const output = '1\n2\n3\n4\n5\n6';
    expect(shellOutputPreview(output)).toContain('… (1 more line)');
  });
});
