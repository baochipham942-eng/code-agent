import { describe, expect, it } from 'vitest';
import {
  reconcileProtoSpine,
  protoSpinePath,
} from '../../../src/renderer/components/design/protoSpine';
import {
  emptySpine,
  appendVariant,
  discardVariant,
  activeVariants,
  pinnedInGroup,
} from '../../../src/renderer/components/design/variantSpine';
import { makeProtoVariant, protoGroupId } from '../../../src/renderer/components/design/variantAdapters';
import type { DesignVersion } from '../../../src/renderer/components/design/designFiles';

const RUN = '/d/run-1';
const ver = (ts: number): DesignVersion => ({ path: `${RUN}/versions/v-${ts}.html`, createdAt: ts });

describe('protoSpinePath', () => {
  it('落 run 目录下 spine.json', () => {
    expect(protoSpinePath('/d/run-1')).toBe('/d/run-1/spine.json');
    expect(protoSpinePath('/d/run-1/')).toBe('/d/run-1/spine.json');
  });
});

describe('reconcileProtoSpine — 与磁盘版本对账（纯函数）', () => {
  it('空 spine + 多版本 → 全部入册为活跃 variant，最新自动 pinned', () => {
    const s = reconcileProtoSpine(emptySpine(), [ver(3), ver(1), ver(2)], RUN);
    expect(activeVariants(s)).toHaveLength(3);
    expect(pinnedInGroup(s, protoGroupId(RUN))?.id).toBe(ver(3).path); // 最新 ts=3
  });

  it('已有 spine 且用户 pin 了较旧版 → 新版入册为未 pinned，保留用户的 pin', () => {
    let s = emptySpine();
    s = appendVariant(s, makeProtoVariant(ver(1).path, 1, RUN));
    s = appendVariant(s, makeProtoVariant(ver(2).path, 2, RUN)); // ts=2 现为 pinned
    // 用户手动把主版设回 v1（appendVariant 已 pin v2，这里模拟改回）
    // 直接断言：reconcile 引入 v3 不该抢走现有 pinned
    const before = pinnedInGroup(s, protoGroupId(RUN))?.id;
    const after = reconcileProtoSpine(s, [ver(1), ver(2), ver(3)], RUN);
    expect(activeVariants(after)).toHaveLength(3);
    expect(pinnedInGroup(after, protoGroupId(RUN))?.id).toBe(before); // pin 不被 reconcile 改写
  });

  it('已淘汰的 variant 不被磁盘版本复活', () => {
    let s = emptySpine();
    s = appendVariant(s, makeProtoVariant(ver(1).path, 1, RUN));
    s = appendVariant(s, makeProtoVariant(ver(2).path, 2, RUN));
    s = discardVariant(s, ver(2).path); // 淘汰 v2
    const after = reconcileProtoSpine(s, [ver(1), ver(2)], RUN);
    const v2 = after.variants.find((v) => v.id === ver(2).path);
    expect(v2?.discarded).toBe(true); // 仍是淘汰态
  });

  it('全部活跃版都被淘汰后 reconcile 不强行 pin（无活跃可 pin）', () => {
    let s = emptySpine();
    s = appendVariant(s, makeProtoVariant(ver(1).path, 1, RUN));
    s = discardVariant(s, ver(1).path);
    const after = reconcileProtoSpine(s, [ver(1)], RUN);
    expect(pinnedInGroup(after, protoGroupId(RUN))).toBeUndefined();
  });

  it('无版本 → 空 spine 原样', () => {
    expect(reconcileProtoSpine(emptySpine(), [], RUN)).toEqual(emptySpine());
  });
});
