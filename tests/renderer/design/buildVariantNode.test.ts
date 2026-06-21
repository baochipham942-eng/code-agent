// ============================================================================
// T3 功能 dogfood（无 DOM）：扩图四向 + 去水印各落新 variant 挂 T1 spine。
// 用真 buildVariantNode（hook 落盘所用同一构造）+ 真 designCanvasStore + 真 groupKey，
// 验证 5 个结果节点都挂在底图的版本槽（spine 同槽、非破坏性追加），落底图右侧、取结果真尺寸。
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { buildVariantNode, nextVariantNodeId } from '../../../src/renderer/components/design/useDesignCanvasGeneration';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import { emptyCanvasDoc, type CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';
import { groupKey } from '../../../src/renderer/components/design/variantSpine';
import { DESIGN_WORKSPACE } from '../../../src/shared/constants';

const BASE: CanvasImageNode = {
  id: 'base-1',
  src: 'assets/base.png',
  x: 10,
  y: 20,
  width: 800,
  height: 600,
  createdAt: 1,
};

// 各操作的结果图（扩图结果尺寸大于原图；去水印同尺寸）。
const OPS: ReadonlyArray<{ label: string; rel: string; dims: { width: number; height: number } }> = [
  { label: '扩展画布', rel: 'assets/expand-up.png', dims: { width: 800, height: 900 } },
  { label: '扩展画布', rel: 'assets/expand-down.png', dims: { width: 800, height: 900 } },
  { label: '扩展画布', rel: 'assets/expand-left.png', dims: { width: 1200, height: 600 } },
  { label: '扩展画布', rel: 'assets/expand-right.png', dims: { width: 1200, height: 600 } },
  { label: '去除水印', rel: 'assets/dewm.png', dims: { width: 800, height: 600 } },
];

describe('T3 扩图/去水印结果落 variant 挂 spine', () => {
  beforeEach(() => {
    useDesignCanvasStore.getState().loadDoc('/design/run', { ...emptyCanvasDoc(), nodes: [BASE] });
  });

  it('缺省 id 同毫秒内不碰撞（防 store 内 id 歧义）', () => {
    // 同一 tick 连续构造多个节点，id 必须各异
    const ids = new Set(
      Array.from({ length: 5 }, () => buildVariantNode(BASE, 'assets/x.png', { width: 1, height: 1 }, 'l').id),
    );
    expect(ids.size).toBe(5);
  });

  it('nextVariantNodeId 同毫秒连续调用各异（generate/editRegion 共用同一防碰撞源）', () => {
    const ids = new Set(Array.from({ length: 8 }, () => nextVariantNodeId()));
    expect(ids.size).toBe(8);
    expect([...ids].every((id) => id.startsWith('node-'))).toBe(true);
  });

  it('5 个操作各追加一个新 variant，全部挂底图版本槽且落右侧', () => {
    OPS.forEach((op, i) => {
      const node = buildVariantNode(BASE, op.rel, op.dims, op.label, `node-${i}`, 100 + i);
      useDesignCanvasStore.getState().addNode(node);
    });

    const store = useDesignCanvasStore.getState();
    expect(store.nodes).toHaveLength(6); // 底图 + 5 variant
    const variants = store.nodes.filter((n) => n.id !== BASE.id);
    expect(variants).toHaveLength(5);

    for (const v of variants) {
      // 同一 spine 槽（groupKey 收敛到底图）
      expect(v.parentId).toBe(groupKey(BASE));
      expect(groupKey(v)).toBe(groupKey(BASE));
      // 非破坏性：底图仍在、未被覆盖
      expect(v.id).not.toBe(BASE.id);
      // 落底图右侧（make-real 式 x = 底图右缘 + gap）
      expect(v.x).toBe(BASE.x + BASE.width + DESIGN_WORKSPACE.CANVAS_NODE_GAP);
      expect(v.y).toBe(BASE.y);
    }

    // 扩图结果尺寸取自结果图（大于原图），去水印保持原尺寸
    const expandRight = variants.find((v) => v.src === 'assets/expand-right.png');
    expect(expandRight?.width).toBe(1200);
    const dewm = variants.find((v) => v.src === 'assets/dewm.png');
    expect(dewm?.width).toBe(800);
    expect(dewm?.height).toBe(600);

    // 底图本身未被改动
    const base = store.nodes.find((n) => n.id === BASE.id);
    expect(base).toMatchObject({ id: 'base-1', width: 800, height: 600 });
  });
});
