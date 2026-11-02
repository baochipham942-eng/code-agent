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
      deletionAnchor: null,
    });
    expect(hunks[1]).toEqual({
      index: 2,
      startLine: 6,
      endLine: 6,
      added: 1,
      removed: 0,
      excerpt: '+f',
      deletionAnchor: null,
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
        deletionAnchor: null,
      },
    ]);
  });

  it('中部纯删除：锚在删除后顶上来的那行（before 语义），摘录带 - 前缀', () => {
    const hunks = buildTurnDiffHunks('x\ny\nz\n', 'x\nz\n');
    expect(hunks).toEqual([
      {
        index: 1,
        startLine: 2,
        endLine: 2,
        added: 0,
        removed: 1,
        excerpt: '-y',
        deletionAnchor: 'before',
      },
    ]);
  });

  it('文件尾删除：锚点不夹回上一行——行号 = 新文件长度+1，deletionAnchor=after', () => {
    // a/b/c 删掉 c：删除发生在新文件末尾之后（游标第 3 行），第 2 行 b 两边相同、没被改过。
    // 夹回第 2 行会让消息把未改动的 b 说成要改的行——这里钉死不夹回。
    const hunks = buildTurnDiffHunks('a\nb\nc\n', 'a\nb\n');
    expect(hunks).toEqual([
      { index: 1, startLine: 3, endLine: 3, added: 0, removed: 1, excerpt: '-c', deletionAnchor: 'after' },
    ]);
  });

  it('文件尾多行删除同样锚在末尾之后（不夹到最后一行存活行）', () => {
    const hunks = buildTurnDiffHunks('a\nb\nc\nd\n', 'a\n');
    expect(hunks).toEqual([
      { index: 1, startLine: 2, endLine: 2, added: 0, removed: 3, excerpt: '-b\n-c\n-d', deletionAnchor: 'after' },
    ]);
  });

  it('删空整个文件：after 语义，startLine=1（新文件 0 行之后）', () => {
    const hunks = buildTurnDiffHunks('a\nb\n', '');
    expect(hunks).toEqual([
      { index: 1, startLine: 1, endLine: 1, added: 0, removed: 2, excerpt: '-a\n-b', deletionAnchor: 'after' },
    ]);
  });

  it('新建文件：单个块覆盖 1..N 行', () => {
    const text = 'p\nq\nr\n';
    const hunks = buildTurnDiffHunks('', text);
    expect(hunks).toEqual([
      { index: 1, startLine: 1, endLine: 3, added: 3, removed: 0, excerpt: '+p\n+q\n+r', deletionAnchor: null },
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

  it('摘录截断给 -/+ 两侧都留额度：20 删 20 增的替换各带 6 行', () => {
    // diffLines 对大段替换先输出 removed 后输出 added；顺序 slice(0,12) 会全是 - 行
    const olds = Array.from({ length: 20 }, (_, i) => `old${i + 1}`).join('\n');
    const news = Array.from({ length: 20 }, (_, i) => `new${i + 1}`).join('\n');
    const hunks = buildTurnDiffHunks(`head\n${olds}\n`, `head\n${news}\n`);
    expect(hunks).toHaveLength(1);
    const lines = hunks[0].excerpt.split('\n');
    expect(lines).toHaveLength(12);
    expect(lines.slice(0, 6)).toEqual(Array.from({ length: 6 }, (_, i) => `-old${i + 1}`));
    expect(lines.slice(6, 12)).toEqual(Array.from({ length: 6 }, (_, i) => `+new${i + 1}`));
    // 计数与行区间不受摘录截断影响
    expect(hunks[0].added).toBe(20);
    expect(hunks[0].removed).toBe(20);
    expect(hunks[0].startLine).toBe(2);
    expect(hunks[0].endLine).toBe(21);
  });

  it('一侧用不完的摘录额度让给另一侧：2 删 20 增 = 2 个 - 行 + 10 个 + 行', () => {
    const olds = 'old1\nold2';
    const news = Array.from({ length: 20 }, (_, i) => `new${i + 1}`).join('\n');
    const hunks = buildTurnDiffHunks(`head\n${olds}\n`, `head\n${news}\n`);
    const lines = hunks[0].excerpt.split('\n');
    expect(lines).toHaveLength(12);
    expect(lines.slice(0, 2)).toEqual(['-old1', '-old2']);
    expect(lines.slice(2, 12)).toEqual(Array.from({ length: 10 }, (_, i) => `+new${i + 1}`));
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
        deletionAnchor: null,
      },
    ]);
  });
});
