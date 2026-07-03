// ============================================================================
// routingToolPolicy — 显式 /agent 路由的工具约束（Explorer 真只读）
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  READONLY_TOOL_DENYLIST,
  buildRoutingToolDenylist,
} from '../../../src/host/agent/routingToolPolicy';

describe('buildRoutingToolDenylist', () => {
  it('readonly agent → 拒掉全部文件写入工具（两种命名变体）', () => {
    const denied = buildRoutingToolDenylist({ readonly: true });
    for (const name of ['Write', 'write_file', 'Edit', 'edit_file', 'Append', 'append_file']) {
      expect(denied).toContain(name);
    }
  });

  it('非 readonly / 未标记 / 空 agent → 不加任何约束', () => {
    expect(buildRoutingToolDenylist({ readonly: false })).toEqual([]);
    expect(buildRoutingToolDenylist({})).toEqual([]);
    expect(buildRoutingToolDenylist(undefined)).toEqual([]);
    expect(buildRoutingToolDenylist(null)).toEqual([]);
  });

  it('denylist 与 spawnGuard 只读子代理语义一致（单一来源）', () => {
    expect(new Set(buildRoutingToolDenylist({ readonly: true }))).toEqual(new Set(READONLY_TOOL_DENYLIST));
  });
});
