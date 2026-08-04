// 出图复述/验收句（工单 2026-07-31）：比例数学 + 三句构造 + 反套话门。
//
// 反套话门是本批的承重测试：本仓有「可被润色的状态名词最终都会被润成『已完成』」的血账，
// 所以这里把「验收句不得出现状态套话」钉成机器可判的断言，而不是靠人 review 时记得。
import { describe, it, expect } from 'vitest';
import {
  aspectOrientation,
  aspectRatioMatches,
  aspectRatioValue,
  expectedExpandSize,
  expectedExpandSizeFromScales,
  parsePngDimensions,
  sizeApproxEquals,
} from '@shared/media/imageNarration';
import { computeResizeExpandPlan } from '@renderer/components/design/designCanvasResizeRatio';
import {
  buildCanvasBriefing,
  buildCanvasFailure,
  buildCanvasVerdict,
  type CanvasOpSpec,
} from '@renderer/components/design/designNarration';
import { zh } from '@renderer/i18n/zh';
import { en } from '@renderer/i18n/en';

const nt = zh.imageNarration;

describe('比例数学', () => {
  it('解析比例值，非法输入返回 undefined', () => {
    expect(aspectRatioValue('9:16')).toBeCloseTo(0.5625);
    expect(aspectRatioValue('16:9')).toBeCloseTo(1.7778, 3);
    expect(aspectRatioValue('1:1')).toBe(1);
    expect(aspectRatioValue('abc')).toBeUndefined();
    expect(aspectRatioValue('9:0')).toBeUndefined();
  });

  it('朝向按数值判定，未知比例不猜', () => {
    expect(aspectOrientation('9:16')).toBe('portrait');
    expect(aspectOrientation('16:9')).toBe('landscape');
    expect(aspectOrientation('1:1')).toBe('square');
    expect(aspectOrientation('nonsense')).toBeUndefined();
  });

  it('各引擎对同一比例的像素档差异（720×1280 / 768×1344 / 1024×1792）都判为相符', () => {
    expect(aspectRatioMatches(720, 1280, '9:16')).toBe(true);
    expect(aspectRatioMatches(768, 1344, '9:16')).toBe(true);
    expect(aspectRatioMatches(1024, 1792, '9:16')).toBe(true);
    expect(aspectRatioMatches(1792, 1024, '16:9')).toBe(true);
  });

  it('要 9:16 却给方图判为不符——这正是验收句要抓的跑偏', () => {
    expect(aspectRatioMatches(1024, 1024, '9:16')).toBe(false);
    expect(aspectRatioMatches(1024, 1024, '16:9')).toBe(false);
  });

  it('输入不可解析时返回 undefined，让调用方省掉断言而不是猜', () => {
    expect(aspectRatioMatches(1024, 1024, 'bogus')).toBeUndefined();
    expect(aspectRatioMatches(0, 100, '1:1')).toBeUndefined();
  });

  it('扩图预期尺寸按方向只涨对应的轴', () => {
    expect(expectedExpandSize(800, 600, 'right', 1.5)).toEqual({ width: 1200, height: 600 });
    expect(expectedExpandSize(800, 600, 'left', 1.5)).toEqual({ width: 1200, height: 600 });
    expect(expectedExpandSize(800, 600, 'up', 1.5)).toEqual({ width: 800, height: 900 });
    expect(expectedExpandSize(800, 600, 'all', 1.5)).toEqual({ width: 1600, height: 1200 });
    expect(expectedExpandSize(0, 600, 'up', 1.5)).toBeUndefined();
  });

  it('四向 scale 的预期尺寸：W′=W×(left+right−1)，H′=H×(top+bottom−1)', () => {
    expect(expectedExpandSizeFromScales(800, 600, { top: 1, bottom: 1, left: 1.5, right: 1.5 }))
      .toEqual({ width: 1600, height: 600 });
    expect(expectedExpandSizeFromScales(800, 600, { top: 1.25, bottom: 1.25, left: 1, right: 1 }))
      .toEqual({ width: 800, height: 900 });
    // 非对称：只往右扩，左边不动。
    expect(expectedExpandSizeFromScales(800, 600, { top: 1, bottom: 1, left: 1, right: 1.5 }))
      .toEqual({ width: 1200, height: 600 });
    expect(expectedExpandSizeFromScales(0, 600, { top: 1, bottom: 1, left: 1, right: 1.5 })).toBeUndefined();
    expect(expectedExpandSizeFromScales(800, 600, { top: 0, bottom: 1, left: 1, right: 1 })).toBeUndefined();
  });

  it('单方向形态与四向形态同源：direction+ratio 只是 scales 的一个特例', () => {
    const cases = [
      ['right', { top: 1, bottom: 1, left: 1, right: 1.5 }],
      ['left', { top: 1, bottom: 1, left: 1.5, right: 1 }],
      ['up', { top: 1.5, bottom: 1, left: 1, right: 1 }],
      ['down', { top: 1, bottom: 1.5, left: 1, right: 1 }],
      ['all', { top: 1.5, bottom: 1.5, left: 1.5, right: 1.5 }],
    ] as const;
    for (const [direction, scales] of cases) {
      expect(expectedExpandSize(800, 600, direction, 1.5)).toEqual(expectedExpandSizeFromScales(800, 600, scales));
    }
  });

  it('「调整大小」算出的 scale 反算回去就是目标比例——验收句和换算器必须同一条式子', () => {
    // 两者若各算各的，验收句会对着正确的产出图报「与预期不一致」。
    const plan = computeResizeExpandPlan(1024, 1024, 9 / 16);
    expect(plan.feasible).toBe(true);
    if (!plan.feasible || !plan.scales) throw new Error('本用例需要一份可行且需扩图的方案');
    const expected = expectedExpandSizeFromScales(1024, 1024, plan.scales);
    expect(expected).toBeDefined();
    expect(expected!.width / expected!.height).toBeCloseTo(9 / 16, 2);
  });

  it('尺寸近似比较容得下取整/对齐误差，容不下真跑偏', () => {
    expect(sizeApproxEquals({ width: 1200, height: 600 }, { width: 1208, height: 600 })).toBe(true);
    expect(sizeApproxEquals({ width: 800, height: 600 }, { width: 1200, height: 600 })).toBe(false);
  });
});

describe('PNG 尺寸解析', () => {
  function pngHeader(width: number, height: number): Uint8Array {
    const buf = new Uint8Array(24);
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(buf.buffer).setUint32(16, width, false);
    new DataView(buf.buffer).setUint32(20, height, false);
    return buf;
  }

  it('读出 IHDR 宽高', () => {
    expect(parsePngDimensions(pngHeader(1024, 1792))).toEqual({ width: 1024, height: 1792 });
  });

  it('非 PNG / 过短 / 零宽高一律返回 undefined，不猜数', () => {
    expect(parsePngDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeUndefined();
    expect(parsePngDimensions(new Uint8Array(10))).toBeUndefined();
    expect(parsePngDimensions(pngHeader(0, 100))).toBeUndefined();
  });

  it('在带 byteOffset 的视图上也读对（Buffer 常是共享 ArrayBuffer 的切片）', () => {
    const backing = new Uint8Array(64);
    backing.set(pngHeader(720, 1280), 20);
    const view = backing.subarray(20);
    expect(parsePngDimensions(view)).toEqual({ width: 720, height: 1280 });
  });
});

describe('画布复述句（动手前）', () => {
  it('文生图：回显用户原话 + 比例朝向 + 付费提示', () => {
    const spec: CanvasOpSpec = { op: 'generate', requirement: '一只柯基在草地上', ratio: '9:16' };
    const text = buildCanvasBriefing(nt, spec);
    expect(text).toContain('一只柯基在草地上');
    expect(text).toContain('9:16');
    expect(text).toContain('竖版');
    expect(text).toContain('打断');
  });

  it('扩图：说清保住什么（原图像素）、不做什么（不拉伸）', () => {
    const spec: CanvasOpSpec = { op: 'expand', direction: 'up', ratio: 1.5, base: { width: 800, height: 600 } };
    const text = buildCanvasBriefing(nt, spec);
    expect(text).toContain('上');
    expect(text).toContain('800×600');
    expect(text).toContain('原样保留');
    expect(text).toContain('不拉伸');
  });

  it('四向扩图（「调整大小」比例预设）：说不出单一方向，就说从多大补到多大', () => {
    const spec: CanvasOpSpec = {
      op: 'expand',
      scales: { top: 1, bottom: 1, left: 1.4, right: 1.4 },
      base: { width: 800, height: 600 },
    };
    const text = buildCanvasBriefing(nt, spec);
    expect(text).toContain('800×600');
    expect(text).toContain('1440×600'); // 800×(1.4+1.4−1)
    expect(text).toContain('原样保留');
    // 走的是四向 scale，就不该冒出一个「向上/向下」的方向词。
    for (const word of ['向上', '向下', '向左', '向右', '向四周']) expect(text).not.toContain(word);
  });

  it('局部重绘：说清只动框选区域、框外不动', () => {
    const spec: CanvasOpSpec = {
      op: 'editRegion', instruction: '把天空改成晚霞', regionCount: 2, base: { width: 800, height: 600 },
    };
    const text = buildCanvasBriefing(nt, spec);
    expect(text).toContain('把天空改成晚霞');
    expect(text).toContain('2');
    expect(text).toContain('框外像素不动');
  });
});

describe('画布验收句（出完）', () => {
  const genSpec: CanvasOpSpec = { op: 'generate', requirement: '柯基', ratio: '9:16' };

  it('比例相符：给出实际像素并明说与所要比例相符', () => {
    const text = buildCanvasVerdict(nt, genSpec, { width: 720, height: 1280 });
    expect(text).toContain('720×1280');
    expect(text).toContain('相符');
    expect(text).not.toContain('不符');
  });

  it('比例跑偏：验收句必须点破，不能糊过去', () => {
    const text = buildCanvasVerdict(nt, genSpec, { width: 1024, height: 1024 });
    expect(text).toContain('1024×1024');
    expect(text).toContain('不符');
    expect(text).toContain('没按比例出');
  });

  it('比例判不出来时退到纯尺寸事实，不补状态词', () => {
    const spec: CanvasOpSpec = { op: 'generate', requirement: 'x', ratio: 'bogus' };
    const text = buildCanvasVerdict(nt, spec, { width: 500, height: 500 });
    expect(text).toContain('500×500');
    expect(text).not.toContain('相符');
  });

  it('扩图：拿实际尺寸和预期尺寸对数', () => {
    const spec: CanvasOpSpec = { op: 'expand', direction: 'right', ratio: 1.5, base: { width: 800, height: 600 } };
    expect(buildCanvasVerdict(nt, spec, { width: 1200, height: 600 })).toContain('一致');
    const off = buildCanvasVerdict(nt, spec, { width: 800, height: 600 });
    expect(off).toContain('不一致');
    expect(off).toContain('1200×600');
  });

  it('四向扩图：同样拿实际尺寸和预期尺寸对数', () => {
    const spec: CanvasOpSpec = {
      op: 'expand',
      scales: { top: 1.25, bottom: 1.25, left: 1, right: 1 },
      base: { width: 800, height: 600 },
    };
    expect(buildCanvasVerdict(nt, spec, { width: 800, height: 900 })).toContain('一致');
    const off = buildCanvasVerdict(nt, spec, { width: 800, height: 600 });
    expect(off).toContain('不一致');
    expect(off).toContain('800×900');
  });

  it('编辑类承诺「其余像素不动」，尺寸变了必须说出来', () => {
    const spec: CanvasOpSpec = { op: 'removeWatermark', base: { width: 800, height: 600 } };
    expect(buildCanvasVerdict(nt, spec, { width: 800, height: 600 })).toContain('与原图尺寸一致');
    expect(buildCanvasVerdict(nt, spec, { width: 400, height: 300 })).toContain('尺寸变了');
  });

  it('成本已知才写，未知不拿 ¥0.00 冒充', () => {
    expect(buildCanvasVerdict(nt, genSpec, { width: 720, height: 1280 }, '¥0.20')).toContain('¥0.20');
    expect(buildCanvasVerdict(nt, genSpec, { width: 720, height: 1280 })).not.toContain('花费');
  });
});

describe('失败收口', () => {
  it('回指刚才那句复述，并说清画布上没有新图', () => {
    const spec: CanvasOpSpec = { op: 'expand', direction: 'up', ratio: 1.5, base: { width: 800, height: 600 } };
    const text = buildCanvasFailure(nt, spec, '上游超时');
    expect(text).toContain('扩图');
    expect(text).toContain('上游超时');
    expect(text).toContain('画布上没有新图');
  });
});

describe('反套话门：验收句不得出现可被润色成「已完成」的状态词', () => {
  // 这些词一旦进入验收句，模型和 UI 都会把它当成「事情办成了」的信号，
  // 而它们恰恰不携带任何可核对的内容——本仓已有血账，这里机器判死。
  const BANNED = ['已完成', '生成成功', '操作成功', '已生成', '成功了', '完成了'];

  // 这份清单是手工枚举的——每新增一种 op 形态都必须同步加进来，否则新形态会绕开本门。
  // （四向 scale 扩图就是 2026-08 新增的形态，加在这里而不是只测它自己那条。）
  const specs: CanvasOpSpec[] = [
    { op: 'generate', requirement: '柯基', ratio: '9:16' },
    { op: 'expand', direction: 'all', ratio: 1.5, base: { width: 800, height: 600 } },
    { op: 'expand', scales: { top: 1.5, bottom: 1, left: 1, right: 1.2 }, base: { width: 800, height: 600 } },
    { op: 'editRegion', instruction: '改天空', regionCount: 1, base: { width: 800, height: 600 } },
    { op: 'removeWatermark', base: { width: 800, height: 600 } },
    { op: 'annotation', instruction: '改颜色', shapeCount: 3, base: { width: 800, height: 600 } },
  ];

  it.each(specs.map((s) => [s.op, s] as const))('%s 的验收句（相符档）不含套话', (_op, spec) => {
    const text = buildCanvasVerdict(nt, spec, { width: 800, height: 600 }, '¥0.10');
    for (const word of BANNED) expect(text).not.toContain(word);
  });

  it.each(specs.map((s) => [s.op, s] as const))('%s 的验收句（跑偏档）不含套话', (_op, spec) => {
    const text = buildCanvasVerdict(nt, spec, { width: 123, height: 456 });
    for (const word of BANNED) expect(text).not.toContain(word);
  });

  it('每条验收句都带至少一组实测数字，不存在纯定性的空句', () => {
    for (const spec of specs) {
      const text = buildCanvasVerdict(nt, spec, { width: 1024, height: 768 });
      expect(text).toMatch(/1024×768/);
    }
  });
});

describe('i18n 完整性', () => {
  it('zh / en 的 imageNarration 键集合一致（en.ts 同步门）', () => {
    expect(Object.keys(en.imageNarration).sort()).toEqual(Object.keys(zh.imageNarration).sort());
  });

  it('英文侧同样不含套话且带数字', () => {
    const spec: CanvasOpSpec = { op: 'generate', requirement: 'a corgi', ratio: '9:16' };
    const text = buildCanvasVerdict(en.imageNarration, spec, { width: 720, height: 1280 });
    expect(text).toContain('720×1280');
    expect(text.toLowerCase()).not.toContain('successfully');
    expect(text.toLowerCase()).not.toContain('completed');
  });
});
