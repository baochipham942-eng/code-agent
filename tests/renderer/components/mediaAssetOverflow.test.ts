// 媒体产物按钮条溢出折叠（2026-08-02 B3 收尾工单）纯逻辑断言。
// 工单验收要求：断言写成关系式（更窄 ⇒ 溢出集是更宽时的超集），不钉具体像素数——
// 钉一个数字比不钉更危险，会把其他窗口尺寸全排除在视野外。
import { describe, expect, it } from 'vitest';
import { computeVisibleCount } from '../../../src/renderer/components/design/useToolbarOverflow';
import { MEDIA_ASSET_OVERFLOW_IDS } from '../../../src/renderer/components/features/chat/MessageBubble/MediaAssetControls';

// 与 MediaAssetActionBar 生产接线一致的参数：gap-1、⋯ 预留 32、滞回 8、常驻段（修改/复制）计入 fixed。
const GAP = 4;
const RESERVE = 32;
const HYST = 8;
const FIXED_WIDTH = 96;
const FIXED_COUNT = 1;

// 代表性实测宽度（决策函数的输入样本，不是断言对象）。
const WIDTHS = [56, 56, 56, 64];

function overflowAt(avail: number, prev: number): { count: number; ids: ReadonlySet<string> } {
  const count = computeVisibleCount(WIDTHS, avail, RESERVE, GAP, 0, HYST, prev, {
    fixedWidth: FIXED_WIDTH,
    fixedElementCount: FIXED_COUNT,
  });
  return { count, ids: new Set(MEDIA_ASSET_OVERFLOW_IDS.slice(count)) };
}

describe('媒体产物按钮条溢出折叠', () => {
  it('修改/复制 不在可收折域：任何宽度下都不进溢出集', () => {
    expect(MEDIA_ASSET_OVERFLOW_IDS).not.toContain('edit');
    expect(MEDIA_ASSET_OVERFLOW_IDS).not.toContain('copy');
    // 收折从列表末尾开始 ⇒ 列表顺序即收折优先级：Finder(reveal) 最先收，查看(lightbox) 最后收。
    expect([...MEDIA_ASSET_OVERFLOW_IDS]).toEqual(['lightbox', 'open', 'save', 'reveal']);
  });

  it('一路收窄：溢出集单调扩大且始终是更宽时的超集，收折项恒为列表后缀（优先级不乱序）', () => {
    let prevCount = MEDIA_ASSET_OVERFLOW_IDS.length;
    let prevIds: ReadonlySet<string> = new Set();
    for (const avail of [500, 400, 320, 260, 220, 180, 140, 100, 60, 30]) {
      const next = overflowAt(avail, prevCount);
      for (const id of prevIds) expect(next.ids.has(id)).toBe(true);
      expect(new Set(MEDIA_ASSET_OVERFLOW_IDS.slice(next.count))).toEqual(new Set(next.ids));
      prevCount = next.count;
      prevIds = next.ids;
    }
    // 收到最窄：四个可折叠项全进溢出（常驻的修改/复制仍不在内——上一条已钉）。
    expect(prevIds.size).toBe(MEDIA_ASSET_OVERFLOW_IDS.length);
  });

  it('宽度回来双向铺回：收窄后再放宽，溢出集缩小直至全展开', () => {
    const narrow = overflowAt(80, MEDIA_ASSET_OVERFLOW_IDS.length);
    expect(narrow.ids.size).toBeGreaterThan(0);
    const wide = overflowAt(600, narrow.count);
    expect(wide.ids.size).toBe(0);
  });

  it('量不到宽度（avail=0，jsdom/SSR）保持全展开不收折', () => {
    expect(overflowAt(0, MEDIA_ASSET_OVERFLOW_IDS.length).ids.size).toBe(0);
  });
});
