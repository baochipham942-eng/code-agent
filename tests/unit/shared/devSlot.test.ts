import { describe, expect, it } from 'vitest';
import {
  devSlotBundleId,
  devSlotDataDirName,
  devSlotFromBundleId,
  devSlotFromDataDirName,
  devSlotProductName,
  devSlotWebPort,
  MAX_DEV_SLOT,
  parseDevSlot,
  PROD_WEB_PORT,
} from '../../../src/shared/devSlot';

describe('devSlot', () => {
  it('keeps slot 1 byte-identical to the pre-multi-slot identities', () => {
    // 槽 1 = 历史行为。这条一旦破，存量的 ~/.code-agent-dev 数据和已授权的
    // /Applications/Agent Neo Dev.app 会一起失联。
    expect(devSlotBundleId(1)).toBe('com.linchen.code-agent.dev');
    expect(devSlotProductName(1)).toBe('Agent Neo Dev');
    expect(devSlotDataDirName(1)).toBe('.code-agent-dev');
    expect(devSlotWebPort(1)).toBe(8181);
  });

  it('derives distinct identities for every slot', () => {
    const bundleIds = new Set<string>();
    const names = new Set<string>();
    const dirs = new Set<string>();
    const ports = new Set<number>();
    for (let slot = 1; slot <= MAX_DEV_SLOT; slot += 1) {
      bundleIds.add(devSlotBundleId(slot));
      names.add(devSlotProductName(slot));
      dirs.add(devSlotDataDirName(slot));
      ports.add(devSlotWebPort(slot));
    }
    // 四个维度都必须两两不同——任何一个塌成同值，两个测试包就会共用它。
    expect(bundleIds.size).toBe(MAX_DEV_SLOT);
    expect(names.size).toBe(MAX_DEV_SLOT);
    expect(dirs.size).toBe(MAX_DEV_SLOT);
    expect(ports.size).toBe(MAX_DEV_SLOT);
    // 生产端口不能被任何槽占用
    expect(ports.has(PROD_WEB_PORT)).toBe(false);
    expect(devSlotBundleId(2)).toBe('com.linchen.code-agent.dev2');
    expect(devSlotProductName(2)).toBe('Agent Neo Dev 2');
    expect(devSlotDataDirName(2)).toBe('.code-agent-dev2');
    expect(devSlotWebPort(2)).toBe(8182);
  });

  it('round-trips bundle id and data dir back to the slot', () => {
    for (let slot = 1; slot <= MAX_DEV_SLOT; slot += 1) {
      expect(devSlotFromBundleId(devSlotBundleId(slot))).toBe(slot);
      expect(devSlotFromDataDirName(devSlotDataDirName(slot))).toBe(slot);
    }
  });

  it('refuses near-miss identifiers instead of treating them as dev', () => {
    // 判错的代价不是少个端口，是测试包写进生产数据目录。
    expect(devSlotFromBundleId('com.linchen.code-agent')).toBeNull();
    expect(devSlotFromBundleId('com.linchen.code-agent.developer')).toBeNull();
    expect(devSlotFromBundleId('com.linchen.code-agent.dev-old')).toBeNull();
    expect(devSlotFromBundleId('com.linchen.code-agent.dev0')).toBeNull();
    expect(devSlotFromBundleId('com.linchen.code-agent.dev02')).toBeNull();
    expect(devSlotFromBundleId(`com.linchen.code-agent.dev${MAX_DEV_SLOT + 1}`)).toBeNull();
    expect(devSlotFromBundleId(undefined)).toBeNull();
    expect(devSlotFromBundleId('')).toBeNull();
    // `.dev1` 与 `.dev` 都是槽 1（生成器只产出 `.dev`，但读侧要认）
    expect(devSlotFromBundleId('com.linchen.code-agent.dev1')).toBe(1);
  });

  it('refuses near-miss data dir names', () => {
    expect(devSlotFromDataDirName('.code-agent')).toBeNull();
    expect(devSlotFromDataDirName('.code-agent-development')).toBeNull();
    expect(devSlotFromDataDirName('.code-agent-dev0')).toBeNull();
    expect(devSlotFromDataDirName(`.code-agent-dev${MAX_DEV_SLOT + 1}`)).toBeNull();
  });

  it('rejects an out-of-range or malformed NEO_SLOT instead of silently defaulting', () => {
    expect(parseDevSlot(undefined)).toBe(1);
    expect(parseDevSlot('')).toBe(1);
    expect(parseDevSlot(' 3 ')).toBe(3);
    // 写错的槽号如果回退成 1，就会悄悄装到别人的槽上；越界必须报错。
    expect(() => parseDevSlot('0')).toThrow(/NEO_SLOT/);
    expect(() => parseDevSlot('-1')).toThrow(/NEO_SLOT/);
    expect(() => parseDevSlot('two')).toThrow(/NEO_SLOT/);
    expect(() => parseDevSlot(String(MAX_DEV_SLOT + 1))).toThrow(/NEO_SLOT/);
  });

  it('rejects out-of-range slots in every derivation', () => {
    for (const bad of [0, MAX_DEV_SLOT + 1, 1.5]) {
      expect(() => devSlotBundleId(bad)).toThrow();
      expect(() => devSlotProductName(bad)).toThrow();
      expect(() => devSlotDataDirName(bad)).toThrow();
      expect(() => devSlotWebPort(bad)).toThrow();
    }
  });
});
