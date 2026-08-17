// 装卸历史投影纯函数（N-LEDGER-P5 判据①③ + 变异验证锚点）
import { describe, expect, it } from 'vitest';
import { projectCapabilityLifecycleHistory, splitCapabilityKey } from '../../../src/renderer/utils/capabilityLifecycleHistory';
import type { TraceLedgerEvent } from '../../../src/renderer/services/traceLedgerClient';

function ev(type: string, data: unknown, ts: number): TraceLedgerEvent {
  return { ts, sessionId: 'capability-runtime', turnIndex: 0, type, data };
}

function lifecycle(capabilityKey: string, action: string, ts: number, detail?: string): TraceLedgerEvent {
  return ev('capability_lifecycle', detail === undefined
    ? { capabilityKey, action }
    : { capabilityKey, action, detail }, ts);
}

describe('projectCapabilityLifecycleHistory', () => {
  it('① 按 capabilityKey 分组；组内按 ts 倒序；组间按组内最新 ts 倒序', () => {
    const { groups, unreadable } = projectCapabilityLifecycleHistory([
      lifecycle('skill-a', 'loaded', 100),
      lifecycle('skill-b', 'loaded', 200),
      lifecycle('skill-a', 'unloaded', 300),
      lifecycle('skill-a', 'loaded', 400),
    ]);

    expect(unreadable).toBe(0);
    expect(groups.map((g) => g.capabilityKey)).toEqual(['skill-a', 'skill-b']);
    expect(groups[0].entries.map((e) => e.ts)).toEqual([400, 300, 100]);
    expect(groups[0].entries.map((e) => e.action)).toEqual(['loaded', 'unloaded', 'loaded']);
    expect(groups[1].entries.map((e) => e.ts)).toEqual([200]);
  });

  it('② failed 事件的 detail 原样保留（host error.message，不加工）', () => {
    const { groups } = projectCapabilityLifecycleHistory([
      lifecycle('skill-x', 'failed', 100, 'ENOENT: no such file'),
    ]);
    expect(groups[0].entries[0]).toMatchObject({
      capabilityKey: 'skill-x',
      action: 'failed',
      detail: 'ENOENT: no such file',
    });
  });

  it('③ 脏数据安静丢弃并计数：非本类型只跳过、本类型读不懂才计数，不 throw 不臆造', () => {
    const { groups, unreadable } = projectCapabilityLifecycleHistory([
      // 其他事件类型即使 data 长得像也一律丢弃（变异验证锚点：删掉 type 过滤这里必须转红）
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

    expect(unreadable).toBe(7);   // turn_outcome 不算读不懂（它不是本视图的事件），ghost 仍必须不进分组
    expect(groups.map((g) => g.capabilityKey)).toEqual(['skill-a']);
    expect(groups[0].entries).toHaveLength(1);
  });

  it('③b ts 缺失/非数按 0 处理，排到组内末尾，不影响其余事件', () => {
    const { groups, unreadable } = projectCapabilityLifecycleHistory([
      { sessionId: 'capability-runtime', turnIndex: 0, type: 'capability_lifecycle', data: { capabilityKey: 'skill-a', action: 'loaded' } },
      { ts: 'not-a-number', sessionId: 'capability-runtime', turnIndex: 0, type: 'capability_lifecycle', data: { capabilityKey: 'skill-a', action: 'unloaded' } },
      lifecycle('skill-a', 'loaded', 500),
    ]);

    expect(unreadable).toBe(0);
    expect(groups[0].entries.map((e) => e.ts)).toEqual([500, 0, 0]);
  });

  it('空输入 → 空历史，unreadable=0', () => {
    expect(projectCapabilityLifecycleHistory([])).toEqual({ groups: [], unreadable: 0 });
  });
});

describe('splitCapabilityKey', () => {
  it('拆出命名空间的 i18n key 与名字，供展示层说人话', () => {
    expect(splitCapabilityKey('skill:internal-comms')).toEqual({ namespaceKey: 'nsSkill', name: 'internal-comms' });
    expect(splitCapabilityKey('connector:lark')).toEqual({ namespaceKey: 'nsConnector', name: 'lark' });
  });

  it('认不出/形状不对时返回 null，让展示层原样露出原文（不臆造标签）', () => {
    expect(splitCapabilityKey('weird:thing')).toBeNull();   // 未知命名空间
    expect(splitCapabilityKey('skill:')).toBeNull();        // 缺名字
    expect(splitCapabilityKey(':internal-comms')).toBeNull(); // 缺命名空间
    expect(splitCapabilityKey('no-separator')).toBeNull();
  });
});
