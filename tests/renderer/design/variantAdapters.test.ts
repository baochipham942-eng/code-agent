import { describe, expect, it } from 'vitest';
import {
  canvasNodeToVariant,
  makeProtoVariant,
  protoGroupId,
} from '../../../src/renderer/components/design/variantAdapters';
import type { CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';

const node = (over: Partial<CanvasImageNode> = {}): CanvasImageNode => ({
  id: 'n1',
  src: 'assets/gen-1.png',
  x: 1,
  y: 2,
  width: 100,
  height: 200,
  createdAt: 5,
  ...over,
});

describe('canvasNodeToVariant', () => {
  it('根节点 → canvas-image variant，op=generate，pinned 跟随 chosen', () => {
    const v = canvasNodeToVariant(node({ chosen: true, prompt: '一张落地页' }));
    expect(v.kind).toBe('canvas-image');
    expect(v.id).toBe('n1');
    expect(v.parentId).toBeUndefined();
    expect(v.pinned).toBe(true);
    expect(v.discarded).toBe(false);
    expect(v.op).toBe('generate');
    expect(v.label).toBe('一张落地页');
    expect(v.payload).toEqual({ src: 'assets/gen-1.png', x: 1, y: 2, width: 100, height: 200 });
    expect(v.createdAt).toBe(5);
  });

  it('编辑产物（有 parentId）→ op=edit', () => {
    const v = canvasNodeToVariant(node({ parentId: 'n0', prompt: '改成橙色' }));
    expect(v.parentId).toBe('n0');
    expect(v.op).toBe('edit');
  });

  it('discarded 跟随节点字段（默认 false）', () => {
    expect(canvasNodeToVariant(node()).discarded).toBe(false);
    expect(canvasNodeToVariant(node({ discarded: true })).discarded).toBe(true);
  });
});

describe('proto variant', () => {
  it('protoGroupId 把同一 run 的所有版本归入一个槽', () => {
    expect(protoGroupId('/d/run-1')).toBe(protoGroupId('/d/run-1'));
    expect(protoGroupId('/d/run-1')).not.toBe(protoGroupId('/d/run-2'));
  });

  it('makeProtoVariant → proto-html variant，id=htmlPath，归入 run 槽', () => {
    const v = makeProtoVariant('/d/run-1/versions/v-9.html', 9, '/d/run-1', {
      op: 'continueEdit',
      label: '加 FAQ',
    });
    expect(v.kind).toBe('proto-html');
    expect(v.id).toBe('/d/run-1/versions/v-9.html');
    expect(v.parentId).toBe(protoGroupId('/d/run-1'));
    expect(v.createdAt).toBe(9);
    expect(v.op).toBe('continueEdit');
    expect(v.label).toBe('加 FAQ');
    expect(v.payload).toEqual({ htmlPath: '/d/run-1/versions/v-9.html' });
    // 未 pinned（由 appendVariant 决定 pinned）
    expect(v.pinned).toBe(false);
    expect(v.discarded).toBe(false);
  });
});

describe('canvasNodeToVariant 空 label 回退（审计 R2 LOW symmetric）', () => {
  it('空串/纯空白 label 回退到 prompt（与 stepName 的 trim 判定对齐）', () => {
    const v1 = canvasNodeToVariant(node({ label: '', prompt: '橙色按钮' }));
    expect(v1.label).toBe('橙色按钮');
    const v2 = canvasNodeToVariant(node({ label: '   ', prompt: '橙色按钮' }));
    expect(v2.label).toBe('橙色按钮');
    const v3 = canvasNodeToVariant(node({ label: '我的命名', prompt: '橙色按钮' }));
    expect(v3.label).toBe('我的命名');
  });
});
