// 装卸历史投影纯函数（N-LEDGER-P5B 判据①~⑥ + 变异验证锚点）
import { describe, expect, it } from 'vitest';
import { projectCapabilityLifecycleHistory, sharedNamespaceKey, splitCapabilityKey } from '../../../src/renderer/utils/capabilityLifecycleHistory';
import type { TraceLedgerEvent } from '../../../src/renderer/services/traceLedgerClient';

function ev(type: string, data: unknown, ts: number): TraceLedgerEvent {
  return { ts, sessionId: 'capability-runtime', turnIndex: 0, type, data };
}

function lifecycle(capabilityKey: string, action: string, ts: number, detail?: string): TraceLedgerEvent {
  return ev('capability_lifecycle', detail === undefined
    ? { capabilityKey, action }
    : { capabilityKey, action, detail }, ts);
}

/** 造一批同动作爆发：keys 从 startTs 起每条间隔 stepMs（默认毫秒级，模拟同一同步循环打点） */
function burst(keys: string[], action: string, startTs: number, stepMs = 1): TraceLedgerEvent[] {
  return keys.map((key, index) => lifecycle(key, action, startTs + index * stepMs));
}

describe('projectCapabilityLifecycleHistory', () => {
  it('① 跨秒边界的一次爆发聚成一批（真账本 10+40 形状：同动作、毫秒级间隔、跨了秒）', () => {
    const keys = Array.from({ length: 50 }, (_, i) => `skill:k${String(i).padStart(2, '0')}`);
    // 10 条落在 ...005 秒，40 条落在 ...006 秒——同一次冷启动装载，跨了秒边界
    const { batches, unreadable } = projectCapabilityLifecycleHistory([
      ...burst(keys.slice(0, 10), 'loaded', 1_000_005, 1),
      ...burst(keys.slice(10), 'loaded', 1_000_006, 1),
    ]);

    expect(unreadable).toBe(0);
    expect(batches).toHaveLength(1);
    expect(batches[0].action).toBe('loaded');
    expect(batches[0].capabilityKeys).toHaveLength(50);
    expect(batches[0].ts).toBe(1_000_006 + 39); // 批内最新 ts
  });

  it('② action 变化必开新批：同一秒内 unloaded 50 + loaded 49 → 两批', () => {
    const all = Array.from({ length: 50 }, (_, i) => `skill:k${i}`);
    const back = all.slice(0, 49); // 被关掉的那个没装回
    // 真账本 (…472,'unloaded')→50 (…472,'loaded')→49：同毫秒段内动作翻转
    const { batches } = projectCapabilityLifecycleHistory([
      ...burst(all, 'unloaded', 2_000_472, 0),
      ...burst(back, 'loaded', 2_000_472, 0),
    ]);

    expect(batches).toHaveLength(2);
    // 批次按 ts 倒序：loaded 49 在前
    expect(batches.map((b) => b.action)).toEqual(['loaded', 'unloaded']);
    expect(batches[0].capabilityKeys).toHaveLength(49);
    expect(batches[1].capabilityKeys).toHaveLength(50);
  });

  it('③ 间隔 > 2000ms 必开新批：同动作隔 3s（真账本 472 → 475）→ 两批', () => {
    const { batches } = projectCapabilityLifecycleHistory([
      ...burst(['skill:a', 'skill:b'], 'loaded', 3_000_472, 1),
      lifecycle('skill:c', 'loaded', 3_003_475), // 3s 后单独回来的那个
    ]);

    expect(batches).toHaveLength(2);
    expect(batches[0].capabilityKeys).toEqual(['skill:c']); // 倒序：晚的在前
    expect(batches[1].capabilityKeys).toEqual(['skill:a', 'skill:b']);
  });

  it('③b 间隔恰好在 2000ms 边界内仍聚成一批（gap 是 > 不是 >=）', () => {
    const { batches } = projectCapabilityLifecycleHistory([
      lifecycle('skill:a', 'loaded', 1_000_000),
      lifecycle('skill:b', 'loaded', 1_002_000),
    ]);
    expect(batches).toHaveLength(1);
  });

  it('④ 批次按 ts 倒序；批内能力按名字字母序去重', () => {
    const { batches } = projectCapabilityLifecycleHistory([
      // 批 1（老）：乱序 + 重复 key
      lifecycle('skill:z', 'loaded', 100),
      lifecycle('skill:m', 'loaded', 101),
      lifecycle('skill:z', 'loaded', 102),
      // 批 2（新）：另一个动作
      lifecycle('skill:a', 'unloaded', 5000),
    ]);

    expect(batches.map((b) => b.action)).toEqual(['unloaded', 'loaded']);
    expect(batches[0].ts).toBe(5000);
    expect(batches[1].ts).toBe(102);
    expect(batches[1].capabilityKeys).toEqual(['skill:m', 'skill:z']);
  });

  it('④b 同 ts 事件保持写入顺序不打乱（稳定排序），同动作同 ts 仍是一批', () => {
    const { batches } = projectCapabilityLifecycleHistory([
      lifecycle('skill:b', 'loaded', 700),
      lifecycle('skill:a', 'loaded', 700),
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0].capabilityKeys).toEqual(['skill:a', 'skill:b']);
  });

  it('failed 批次的 detail 按能力 key 挂，原文保留（host error.message，不加工）', () => {
    const { batches } = projectCapabilityLifecycleHistory([
      lifecycle('skill:x', 'failed', 100, 'ENOENT: no such file'),
      lifecycle('skill:y', 'failed', 101),
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0].details).toEqual({ 'skill:x': 'ENOENT: no such file' });
  });

  it('⑤ unreadable 语义未回归：非本类型只跳过、本类型读不懂才计数，不 throw 不臆造', () => {
    const { batches, unreadable } = projectCapabilityLifecycleHistory([
      // 其他事件类型即使 data 长得像也一律跳过（变异验证锚点：删掉 type 过滤这里必须转红）
      ev('turn_outcome', { capabilityKey: 'ghost', action: 'loaded' }, 50),
      ev('capability_lifecycle', null, 60),
      ev('capability_lifecycle', ['not', 'an', 'object'], 70),
      ev('capability_lifecycle', 'string-data', 80),
      lifecycle('skill-a', 'exploded', 90),
      ev('capability_lifecycle', { action: 'loaded' }, 100),
      ev('capability_lifecycle', { capabilityKey: '', action: 'loaded' }, 110),
      ev('capability_lifecycle', { capabilityKey: 42, action: 'loaded' }, 120),
      lifecycle('skill-a', 'loaded', 130),
    ]);

    expect(unreadable).toBe(7);   // turn_outcome 不算读不懂（它不是本视图的事件），ghost 仍必须不进批次
    expect(batches).toHaveLength(1);
    expect(batches[0].capabilityKeys).toEqual(['skill-a']);
  });

  it('⑤b ts 缺失/非数按 0 处理，不炸不影响其余事件聚簇', () => {
    const { batches, unreadable } = projectCapabilityLifecycleHistory([
      { sessionId: 'capability-runtime', turnIndex: 0, type: 'capability_lifecycle', data: { capabilityKey: 'skill-a', action: 'loaded' } },
      { ts: 'not-a-number', sessionId: 'capability-runtime', turnIndex: 0, type: 'capability_lifecycle', data: { capabilityKey: 'skill-b', action: 'loaded' } },
      lifecycle('skill-c', 'loaded', 5000),
    ]);

    expect(unreadable).toBe(0);
    expect(batches).toHaveLength(2); // ts=0 一批、ts=5000 一批（间隔 > 2000）
    expect(batches[0].capabilityKeys).toEqual(['skill-c']); // 倒序
    expect(batches[1].capabilityKeys).toEqual(['skill-a', 'skill-b']);
    expect(batches[1].ts).toBe(0);
  });

  it('⑤c 空输入 → { batches: [], unreadable: 0 }', () => {
    expect(projectCapabilityLifecycleHistory([])).toEqual({ batches: [], unreadable: 0 });
  });
});

describe('splitCapabilityKey', () => {
  it('⑥ 拆出命名空间的 i18n key 与名字，供展示层说人话', () => {
    expect(splitCapabilityKey('skill:internal-comms')).toEqual({ namespaceKey: 'nsSkill', name: 'internal-comms' });
    expect(splitCapabilityKey('connector:lark')).toEqual({ namespaceKey: 'nsConnector', name: 'lark' });
  });

  it('⑥b 认不出/形状不对时返回 null，让展示层原样露出原文（不臆造标签）', () => {
    expect(splitCapabilityKey('weird:thing')).toBeNull();   // 未知命名空间
    expect(splitCapabilityKey('skill:')).toBeNull();        // 缺名字
    expect(splitCapabilityKey(':internal-comms')).toBeNull(); // 缺命名空间
    expect(splitCapabilityKey('no-separator')).toBeNull();
  });
});

describe('sharedNamespaceKey', () => {
  it('整批同命名空间 → 返回该命名空间；混合 → null（此时前缀是真区分信息）', () => {
    expect(sharedNamespaceKey(['skill:a', 'skill:b'])).toBe('nsSkill');
    expect(sharedNamespaceKey(['skill:a', 'connector:lark'])).toBeNull();
  });

  it('空批 / 含认不出的 key → null（走逐个带前缀，露原文）', () => {
    expect(sharedNamespaceKey([])).toBeNull();
    expect(sharedNamespaceKey(['skill:a', 'weird:thing'])).toBeNull();
    expect(sharedNamespaceKey(['no-separator'])).toBeNull();
  });
});
