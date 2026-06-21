import { describe, expect, it } from 'vitest';
import {
  emptySpine,
  appendVariant,
  pinVariant,
  discardVariant,
  restoreVariant,
  activeVariants,
  siblingGroup,
  pinnedInGroup,
  groupKey,
  getVariant,
  serializeSpine,
  deserializeSpine,
  type Variant,
  type CanvasImagePayload,
  type ProtoHtmlPayload,
} from '../../../src/renderer/components/design/variantSpine';

const imgPayload = (over: Partial<CanvasImagePayload> = {}): CanvasImagePayload => ({
  src: 'assets/gen-1.png',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  ...over,
});

const protoPayload = (over: Partial<ProtoHtmlPayload> = {}): ProtoHtmlPayload => ({
  htmlPath: '/run/versions/v-1.html',
  ...over,
});

const variant = (over: Partial<Variant> = {}): Variant => ({
  id: 'v1',
  kind: 'canvas-image',
  pinned: false,
  discarded: false,
  createdAt: 1,
  payload: imgPayload(),
  ...over,
});

describe('emptySpine', () => {
  it('版本 + 空 variants', () => {
    const s = emptySpine();
    expect(s.version).toBe(1);
    expect(s.variants).toEqual([]);
  });
});

describe('groupKey — 版本槽语义', () => {
  it('根（无 parentId）以自身 id 为组', () => {
    expect(groupKey(variant({ id: 'root', parentId: undefined }))).toBe('root');
  });
  it('编辑产物以 parentId 为组（与原图同槽）', () => {
    expect(groupKey(variant({ id: 'edit', parentId: 'root' }))).toBe('root');
  });
});

describe('appendVariant — op 产物落为新 pinned，永不覆盖', () => {
  it('新 variant 入栈即 pinned，原数组不被改（不可变）', () => {
    const s0 = emptySpine();
    const s1 = appendVariant(s0, variant({ id: 'root' }));
    expect(s0.variants).toHaveLength(0); // 原 spine 未被 mutate
    expect(s1.variants).toHaveLength(1);
    expect(getVariant(s1, 'root')?.pinned).toBe(true);
  });

  it('同槽（同 parentId）追加新版 → 新版 pinned，旧版自动取消 pinned，但都保留（不覆盖）', () => {
    let s = emptySpine();
    s = appendVariant(s, variant({ id: 'root' }));
    s = appendVariant(s, variant({ id: 'edit1', parentId: 'root', createdAt: 2 }));
    s = appendVariant(s, variant({ id: 'edit2', parentId: 'root', createdAt: 3 }));
    // 原图与两次编辑同槽；最新 pinned
    expect(getVariant(s, 'root')?.pinned).toBe(false);
    expect(getVariant(s, 'edit1')?.pinned).toBe(false);
    expect(getVariant(s, 'edit2')?.pinned).toBe(true);
    // 三者都还在，永不覆盖
    expect(s.variants).toHaveLength(3);
  });

  it('不同槽的两个根互不影响 pinned（各自独立产物）', () => {
    let s = emptySpine();
    s = appendVariant(s, variant({ id: 'rootA' }));
    s = appendVariant(s, variant({ id: 'rootB', createdAt: 2 }));
    expect(getVariant(s, 'rootA')?.pinned).toBe(true);
    expect(getVariant(s, 'rootB')?.pinned).toBe(true);
  });
});

describe('pinVariant — 设主版（组内单选）', () => {
  it('pin 一个 → 同槽其余取消，跨槽不动', () => {
    let s = emptySpine();
    s = appendVariant(s, variant({ id: 'root' }));
    s = appendVariant(s, variant({ id: 'edit1', parentId: 'root', createdAt: 2 }));
    s = appendVariant(s, variant({ id: 'other' })); // 另一槽
    s = pinVariant(s, 'root'); // 把主版改回原图
    expect(getVariant(s, 'root')?.pinned).toBe(true);
    expect(getVariant(s, 'edit1')?.pinned).toBe(false);
    expect(getVariant(s, 'other')?.pinned).toBe(true); // 跨槽不受影响
  });

  it('pin 不存在的 id → 原样返回', () => {
    const s = appendVariant(emptySpine(), variant({ id: 'root' }));
    expect(pinVariant(s, 'ghost')).toEqual(s);
  });
});

describe('discardVariant — 淘汰是软删除（落盘保留）', () => {
  it('标 discarded=true，variant 仍在数组里', () => {
    let s = appendVariant(emptySpine(), variant({ id: 'root' }));
    s = discardVariant(s, 'root');
    expect(getVariant(s, 'root')?.discarded).toBe(true);
    expect(s.variants).toHaveLength(1); // 没有真删
  });

  it('淘汰当前主版 → 自动把同槽最新的活跃版升为主版', () => {
    let s = emptySpine();
    s = appendVariant(s, variant({ id: 'root' }));
    s = appendVariant(s, variant({ id: 'edit1', parentId: 'root', createdAt: 2 }));
    // edit1 当前 pinned；淘汰它
    s = discardVariant(s, 'edit1');
    expect(getVariant(s, 'edit1')?.discarded).toBe(true);
    expect(getVariant(s, 'root')?.pinned).toBe(true); // 自动回补主版
  });

  it('restore 可撤销淘汰', () => {
    let s = appendVariant(emptySpine(), variant({ id: 'root' }));
    s = discardVariant(s, 'root');
    s = restoreVariant(s, 'root');
    expect(getVariant(s, 'root')?.discarded).toBe(false);
  });
});

describe('selectors', () => {
  it('activeVariants 过滤 discarded', () => {
    let s = emptySpine();
    s = appendVariant(s, variant({ id: 'a' }));
    s = appendVariant(s, variant({ id: 'b', createdAt: 2 }));
    s = discardVariant(s, 'a');
    expect(activeVariants(s).map((v) => v.id)).toEqual(['b']);
  });

  it('siblingGroup 返回同槽活跃版', () => {
    let s = emptySpine();
    s = appendVariant(s, variant({ id: 'root' }));
    s = appendVariant(s, variant({ id: 'edit1', parentId: 'root', createdAt: 2 }));
    s = appendVariant(s, variant({ id: 'other' }));
    expect(siblingGroup(s, 'edit1').map((v) => v.id).sort()).toEqual(['edit1', 'root']);
  });

  it('pinnedInGroup 返回该槽 pinned 活跃版', () => {
    let s = emptySpine();
    s = appendVariant(s, variant({ id: 'root' }));
    s = appendVariant(s, variant({ id: 'edit1', parentId: 'root', createdAt: 2 }));
    expect(pinnedInGroup(s, 'root')?.id).toBe('edit1');
  });
});

describe('serialize/deserialize round-trip + 容错', () => {
  it('proto-html variant 往返不丢字段', () => {
    let s = emptySpine();
    s = appendVariant(
      s,
      variant({ id: 'p1', kind: 'proto-html', op: 'generate', label: '落地页', payload: protoPayload() }),
    );
    const back = deserializeSpine(serializeSpine(s));
    expect(back).toEqual(s);
  });

  it('null/破损 → 空 spine，不抛', () => {
    expect(deserializeSpine(null)).toEqual(emptySpine());
    expect(deserializeSpine('{not json')).toEqual(emptySpine());
  });

  it('过滤非法 variant（缺 id / 非法 kind / 缺 payload）', () => {
    const text = JSON.stringify({
      version: 1,
      variants: [
        variant({ id: 'ok' }),
        { kind: 'canvas-image', payload: imgPayload() }, // 缺 id
        { id: 'badkind', kind: 'nope', pinned: false, discarded: false, createdAt: 1, payload: imgPayload() },
        { id: 'nopayload', kind: 'proto-html', pinned: false, discarded: false, createdAt: 1 },
      ],
    });
    const s = deserializeSpine(text);
    expect(s.variants.map((v) => v.id)).toEqual(['ok']);
  });
});
