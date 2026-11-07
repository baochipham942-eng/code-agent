import { describe, expect, it } from 'vitest';
// @ts-expect-error —— 纯 JS 手动验证脚本，无类型声明（同 tests/scripts/browserRuntimeDiagnostics.test.ts 模式）
import { EXPECTED_CARDS, buildSeedCases, countClipped, evaluateCase, findOverlaps } from './deliverable-dedup-verify.mjs';

const WORK = '/Users/leo/work/dedup-demo';
const T0 = 1_790_000_000_000;
const COL = { x: 420, y: 0, w: 600, h: 900 };
const card = (y: number) => ({ x: 440, y, w: 400, h: 56 });

// hermetic 覆盖 tests/manual/deliverable-dedup-verify.mjs：不起 webServer、不开浏览器，
// 只钉死脚本自己的三块逻辑——seed fixtures 形状、几何判定、repeated=1/samebase=2/relabs=1/twoturns=2 计数门。
describe('tests/manual/deliverable-dedup-verify.mjs', () => {
  it('EXPECTED_CARDS 钉住计数门：repeated=1、samebase=2、relabs=1、twoturns=2', () => {
    expect(EXPECTED_CARDS).toEqual({ repeated: 1, samebase: 2, relabs: 1, twoturns: 2 });
  });

  describe('buildSeedCases', () => {
    it('repeated：单轮、5 次 Write/Edit 全打同一路径，形状对齐 artifactOwnership', () => {
      const [u, a] = buildSeedCases(WORK, T0).repeated;
      expect(u.role).toBe('user');
      expect(a.role).toBe('assistant');
      const calls = a.toolCalls;
      expect(calls.map((c: { name: string }) => c.name)).toEqual(['Write', 'Edit', 'Edit', 'Write', 'Edit']);
      for (const c of calls) {
        expect(c.arguments.file_path).toBe(`${WORK}/report.html`);
        expect(c.result).toEqual({ toolCallId: c.id, success: true, output: `${c.name} ok`, outputPath: `${WORK}/report.html` });
      }
    });
    it('samebase：单轮写 a/index.html 与 b/index.html（同名不同目录）', () => {
      const [, a] = buildSeedCases(WORK, T0).samebase;
      expect(a.toolCalls.map((c: { arguments: { file_path: string } }) => c.arguments.file_path))
        .toEqual([`${WORK}/a/index.html`, `${WORK}/b/index.html`]);
    });
    it('twoturns：两个连续轮次各写同一路径一次', () => {
      const msgs = buildSeedCases(WORK, T0).twoturns;
      expect(msgs.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(msgs[1].toolCalls[0].arguments.file_path).toBe(`${WORK}/report.html`);
      expect(msgs[3].toolCalls[0].arguments.file_path).toBe(`${WORK}/report.html`);
    });
    it('relabs：单轮里 ./report.html 与绝对路径并存（FU1 后键应折叠为一张卡）', () => {
      const [, a] = buildSeedCases(WORK, T0).relabs;
      expect(a.toolCalls.map((c: { arguments: { file_path: string } }) => c.arguments.file_path))
        .toEqual(['./report.html', `${WORK}/report.html`]);
    });
    it('全套 case 的消息 id 与 toolCall id 互不重复', () => {
      const all = Object.values(buildSeedCases(WORK, T0)).flat() as { id: string; toolCalls?: { id: string }[] }[];
      const ids = all.flatMap((m) => [m.id, ...(m.toolCalls ?? []).map((c) => c.id)]);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('几何判定', () => {
    it('findOverlaps：上下贴排、互不叠压 → 空', () => {
      expect(findOverlaps([card(100), card(180)])).toEqual([]);
    });
    it('findOverlaps：同一位置两张卡（重复卡失败形状）→ 恰一对', () => {
      expect(findOverlaps([card(100), card(104)])).toEqual([[0, 1]]);
    });
    it('findOverlaps：边缘相贴不算叠压', () => {
      expect(findOverlaps([card(100), card(156)])).toEqual([]);
    });
    it('countClipped：列内 0；越过右缘 1；无滚动列给哨兵字符串', () => {
      expect(countClipped([card(100)], COL)).toBe(0);
      expect(countClipped([{ x: 1000, y: 100, w: 400, h: 56 }], COL)).toBe(1);
      expect(countClipped([card(100)], null)).toBe('n/a(no column)');
    });
  });

  describe('evaluateCase（脚本据以退出非零的计数门）', () => {
    it('repeated 1 张卡 → 无失败、geometry=no overlaps', () => {
      const res = evaluateCase('repeated', { labels: ['打开文件预览: report.html'], rects: [card(100)], col: COL }, '/tmp/repeated.png');
      expect(res).toMatchObject({ cardCount: 1, overlaps: 0, clipped: 0, geometry: 'no overlaps', failures: [] });
    });
    it('repeated 5 张卡（两层去重都坏时的真机形状）→ 恰好产出那条 FAIL 行', () => {
      const rects = [0, 1, 2, 3, 4].map((i) => card(100 + i * 80));
      const labels = rects.map(() => '打开文件预览: report.html');
      const res = evaluateCase('repeated', { labels, rects, col: COL }, '/tmp/repeated.png');
      expect(res.failures).toEqual(['FAIL AssertionError: repeated expected cardCount 1 got 5']);
    });
    it('samebase 2 张卡通过；缺一张 → FAIL 行', () => {
      const two = evaluateCase('samebase', { labels: ['l0', 'l1'], rects: [card(100), card(180)], col: COL }, 's');
      expect(two.failures).toEqual([]);
      const one = evaluateCase('samebase', { labels: ['l0'], rects: [card(100)], col: COL }, 's');
      expect(one.failures).toEqual(['FAIL AssertionError: samebase expected cardCount 2 got 1']);
    });
    it('twoturns 2 张卡（owner 决策：每轮一张卡）→ 无失败', () => {
      const res = evaluateCase('twoturns', { labels: ['l0', 'l1'], rects: [card(100), card(180)], col: COL }, 's');
      expect(res.failures).toEqual([]);
    });
    it('twoturns 1 张卡（跨轮合并回归）→ 恰好产出那条 FAIL 行', () => {
      const res = evaluateCase('twoturns', { labels: ['l0'], rects: [card(100)], col: COL }, 's');
      expect(res.failures).toEqual(['FAIL AssertionError: twoturns expected cardCount 2 got 1']);
    });
    it('twoturns 3 张卡 → FAIL 行', () => {
      const res = evaluateCase('twoturns', { labels: ['l0', 'l1', 'l2'], rects: [card(100), card(180), card(260)], col: COL }, 's');
      expect(res.failures).toEqual(['FAIL AssertionError: twoturns expected cardCount 2 got 3']);
    });
    it('relabs 计数门：1 张卡过；2 张卡（裸串 key 的旧形状）→ FAIL 行', () => {
      const one = evaluateCase('relabs', { labels: ['l0'], rects: [card(100)], col: COL }, 's');
      expect(one.failures).toEqual([]);
      const two = evaluateCase('relabs', { labels: ['l0', 'l1'], rects: [card(100), card(180)], col: COL }, 's');
      expect(two.failures).toEqual(['FAIL AssertionError: relabs expected cardCount 1 got 2']);
    });
    it('计数吻合但几何有问题时 geometry=PROBLEM（clipped 哨兵串非零）', () => {
      const res = evaluateCase('repeated', { labels: ['l0'], rects: [card(100)], col: null }, 's');
      expect(res.geometry).toBe('PROBLEM');
    });
  });
});
