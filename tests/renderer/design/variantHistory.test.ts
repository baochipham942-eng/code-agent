import { describe, it, expect } from 'vitest';
import type { Variant, VariantSpine } from '../../../src/renderer/components/design/variantSpine';
import {
  slotTimeline,
  currentVariant,
  previousVariantId,
  nextVariantId,
  canUndo,
  canRedo,
} from '../../../src/renderer/components/design/variantHistory';

function img(id: string, createdAt: number, extra: Partial<Variant> = {}): Variant {
  return {
    id,
    kind: 'canvas-image',
    pinned: false,
    discarded: false,
    createdAt,
    payload: { src: `${id}.png`, x: 0, y: 0, width: 10, height: 10 },
    ...extra,
  };
}

// 槽：root 'n1' + 它的两个编辑版（parentId='n1' → 同槽 groupKey='n1'）。
function spineOf(...vs: Variant[]): VariantSpine {
  return { version: 1, variants: vs };
}

describe('variantHistory.slotTimeline', () => {
  it('按 createdAt 升序列出同槽活跃 variant，排除 discarded', () => {
    const spine = spineOf(
      img('n1', 100),
      img('n3', 300, { parentId: 'n1' }),
      img('n2', 200, { parentId: 'n1', discarded: true }),
      img('other', 150), // 另一槽
    );
    const tl = slotTimeline(spine, 'n1');
    expect(tl.map((v) => v.id)).toEqual(['n1', 'n3']);
  });

  it('未知槽返回空', () => {
    expect(slotTimeline(spineOf(img('n1', 100)), 'nope')).toEqual([]);
  });
});

describe('variantHistory current / 前后版', () => {
  it('无 pinned 时当前=最新活跃版（head），可 undo 到前一版，不可 redo', () => {
    const spine = spineOf(img('n1', 100), img('n2', 200, { parentId: 'n1' }));
    expect(currentVariant(spine, 'n1')?.id).toBe('n2');
    expect(previousVariantId(spine, 'n1')).toBe('n1'); // 一键回滚到前一 variant
    expect(nextVariantId(spine, 'n1')).toBeUndefined();
    expect(canUndo(spine, 'n1')).toBe(true);
    expect(canRedo(spine, 'n1')).toBe(false);
  });

  it('回滚后（pin 前一版）当前=前一版，可 redo 回去，不可再 undo', () => {
    const spine = spineOf(
      img('n1', 100, { pinned: true }),
      img('n2', 200, { parentId: 'n1' }),
    );
    expect(currentVariant(spine, 'n1')?.id).toBe('n1');
    expect(previousVariantId(spine, 'n1')).toBeUndefined();
    expect(nextVariantId(spine, 'n1')).toBe('n2'); // redo target
    expect(canUndo(spine, 'n1')).toBe(false);
    expect(canRedo(spine, 'n1')).toBe(true);
  });

  it('三版中 pin 中间版：前一版/后一版都在', () => {
    const spine = spineOf(
      img('n1', 100),
      img('n2', 200, { parentId: 'n1', pinned: true }),
      img('n3', 300, { parentId: 'n1' }),
    );
    expect(currentVariant(spine, 'n1')?.id).toBe('n2');
    expect(previousVariantId(spine, 'n1')).toBe('n1');
    expect(nextVariantId(spine, 'n1')).toBe('n3');
    expect(canUndo(spine, 'n1')).toBe(true);
    expect(canRedo(spine, 'n1')).toBe(true);
  });

  it('单版槽：既不能 undo 也不能 redo', () => {
    const spine = spineOf(img('n1', 100));
    expect(currentVariant(spine, 'n1')?.id).toBe('n1');
    expect(canUndo(spine, 'n1')).toBe(false);
    expect(canRedo(spine, 'n1')).toBe(false);
  });

  it('空槽：current undefined，前后版 undefined', () => {
    const spine = spineOf(img('x', 1));
    expect(currentVariant(spine, 'missing')).toBeUndefined();
    expect(previousVariantId(spine, 'missing')).toBeUndefined();
    expect(nextVariantId(spine, 'missing')).toBeUndefined();
  });
});

describe('variantHistory 同 createdAt tie-break（审计 LOW）', () => {
  it('同毫秒时间戳按 id 稳定排序，时间线确定', () => {
    const spine = spineOf(
      img('nb', 100, { parentId: 'na' }),
      img('na', 100),
      img('nc', 100, { parentId: 'na' }),
    );
    // groupKey: na 为根(id=na)，nb/nc parentId=na → 同槽 na
    expect(slotTimeline(spine, 'na').map((v) => v.id)).toEqual(['na', 'nb', 'nc']);
  });
});
