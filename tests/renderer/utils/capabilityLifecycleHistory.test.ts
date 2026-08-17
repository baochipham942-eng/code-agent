// 装卸历史投影纯函数（N-LEDGER-P5 判据①③ + 变异验证锚点）
import { describe, expect, it } from 'vitest';
import { projectCapabilityLifecycleHistory } from '../../../src/renderer/utils/capabilityLifecycleHistory';
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
    const { groups, dropped } = projectCapabilityLifecycleHistory([
      lifecycle('skill-a', 'loaded', 100),
      lifecycle('skill-b', 'loaded', 200),
      lifecycle('skill-a', 'unloaded', 300),
      lifecycle('skill-a', 'loaded', 400),
    ]);

    expect(dropped).toBe(0);
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

  it('③ 脏数据安静丢弃并计数：非本类型 / data 非对象 / 未知 action / 缺 key，不 throw 不臆造', () => {
    const { groups, dropped } = projectCapabilityLifecycleHistory([
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

    expect(dropped).toBe(8);
    expect(groups.map((g) => g.capabilityKey)).toEqual(['skill-a']);
    expect(groups[0].entries).toHaveLength(1);
  });

  it('③b ts 缺失/非数按 0 处理，排到组内末尾，不影响其余事件', () => {
    const { groups, dropped } = projectCapabilityLifecycleHistory([
      { sessionId: 'capability-runtime', turnIndex: 0, type: 'capability_lifecycle', data: { capabilityKey: 'skill-a', action: 'loaded' } },
      { ts: 'not-a-number', sessionId: 'capability-runtime', turnIndex: 0, type: 'capability_lifecycle', data: { capabilityKey: 'skill-a', action: 'unloaded' } },
      lifecycle('skill-a', 'loaded', 500),
    ]);

    expect(dropped).toBe(0);
    expect(groups[0].entries.map((e) => e.ts)).toEqual([500, 0, 0]);
  });

  it('空输入 → 空历史，dropped=0', () => {
    expect(projectCapabilityLifecycleHistory([])).toEqual({ groups: [], dropped: 0 });
  });
});
