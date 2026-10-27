// ============================================================================
// turnDiffHunks - 权威 diff 的整文件文本 → 改动块列表（行号新文件坐标）
// 行号是块级反馈消息的承重字段：错一行，模型就改错地方。这里钉死每种 diff 形状。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { buildTurnDiffHunks } from '../../../src/renderer/utils/turnDiffHunks';

describe('buildTurnDiffHunks', () => {
  it('单行改写 + 文件尾追加：分两个块，行号是新文件 1-based 坐标', () => {
    const hunks = buildTurnDiffHunks('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\nf\n');
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({
      index: 1,
      startLine: 2,
      endLine: 2,
      added: 1,
      removed: 1,
      excerpt: '-b\n+B',
    });
    expect(hunks[1]).toEqual({
      index: 2,
      startLine: 6,
      endLine: 6,
      added: 1,
      removed: 0,
      excerpt: '+f',
    });
  });

  it('多行改写成多行：startLine/endLine 覆盖整个新区间', () => {
    const hunks = buildTurnDiffHunks('l1\nl2\nl3\nl4\nl5\n', 'l1\nX\nY\nl4\nl5\n');
    expect(hunks).toEqual([
      {
        index: 1,
        startLine: 2,
        endLine: 3,
        added: 2,
        removed: 2,
        excerpt: '-l2\n-l3\n+X\n+Y',
      },
    ]);
  });

  it('纯删除块：startLine === endLine = 被删内容所在的那一行，摘录带 - 前缀', () => {
    const hunks = buildTurnDiffHunks('x\ny\nz\n', 'x\nz\n');
    expect(hunks).toEqual([
      {
        index: 1,
        startLine: 2,
        endLine: 2,
        added: 0,
        removed: 1,
        excerpt: '-y',
      },
    ]);
  });

  it('文件尾删除：行号夹回新文件长度内', () => {
    const hunks = buildTurnDiffHunks('a\nb\nc\n', 'a\nb\n');
    expect(hunks).toEqual([
      { index: 1, startLine: 2, endLine: 2, added: 0, removed: 1, excerpt: '-c' },
    ]);
  });

  it('新建文件：单个块覆盖 1..N 行', () => {
    const text = 'p\nq\nr\n';
    const hunks = buildTurnDiffHunks('', text);
    expect(hunks).toEqual([
      { index: 1, startLine: 1, endLine: 3, added: 3, removed: 0, excerpt: '+p\n+q\n+r' },
    ]);
  });

  it('无改动返回空数组（不渲染块级反馈入口）', () => {
    expect(buildTurnDiffHunks('same\nlines\n', 'same\nlines\n')).toEqual([]);
    expect(buildTurnDiffHunks('', '')).toEqual([]);
  });

  it('摘录封顶 12 行：20 行追加只带前 12 行', () => {
    const appended = Array.from({ length: 20 }, (_, i) => `n${i + 1}`).join('\n');
    const hunks = buildTurnDiffHunks('base\n', `base\n${appended}\n`);
    expect(hunks).toHaveLength(1);
    const lines = hunks[0].excerpt.split('\n');
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe('+n1');
    expect(lines[11]).toBe('+n12');
    // 行数与区间不受摘录截断影响：块本身还是 20 行
    expect(hunks[0].added).toBe(20);
    expect(hunks[0].endLine).toBe(21);
  });

  it('改动与删除紧邻（同一处修改）算一个块，不因 added/removed 排序拆开', () => {
    // diff 对修改通常先 removed 后 added；两种顺序都应合成一个块
    const hunks = buildTurnDiffHunks('a\nold\nb\n', 'a\nnew1\nnew2\nb\n');
    expect(hunks).toEqual([
      {
        index: 1,
        startLine: 2,
        endLine: 3,
        added: 2,
        removed: 1,
        excerpt: '-old\n+new1\n+new2',
      },
    ]);
  });
});
