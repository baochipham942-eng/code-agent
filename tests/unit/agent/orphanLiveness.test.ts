// ============================================================================
// 孤儿回收父探活谓词（swarm 护栏 P1-2 #5）—— isParentRunAlive
// ============================================================================
//
// 纯函数行为测试：覆盖活跃状态判定 + startTime 区分"同 session 新 run"。
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  collectDescendantAgentIds,
  collectRunningOrphanAgentIds,
  isParentRunAlive,
} from '../../../src/main/agent/orphanLiveness';

describe('isParentRunAlive', () => {
  const SPAWN_TS = 1000;

  it('父处于活跃 run（running/paused/cancelling/queued）且 startTime 一致 → 活', () => {
    for (const status of ['running', 'paused', 'cancelling', 'queued'] as const) {
      expect(isParentRunAlive({ status, startTime: SPAWN_TS }, SPAWN_TS)).toBe(true);
    }
  });

  it('父 run 已结束（idle/error）→ 死（孤儿）', () => {
    expect(isParentRunAlive({ status: 'idle', startTime: SPAWN_TS }, SPAWN_TS)).toBe(false);
    expect(isParentRunAlive({ status: 'error', startTime: SPAWN_TS }, SPAWN_TS)).toBe(false);
  });

  it('同 session 起了新 run（startTime 变了）→ 旧子代理判死', () => {
    // 状态又是 running，但 startTime 与 spawn 时捕获的不一致 → 是新 run，旧子是孤儿
    expect(isParentRunAlive({ status: 'running', startTime: 2000 }, SPAWN_TS)).toBe(false);
  });

  it('startTime 缺失时只在两边都 undefined 才算同一 run', () => {
    expect(isParentRunAlive({ status: 'running', startTime: undefined }, undefined)).toBe(true);
    expect(isParentRunAlive({ status: 'running', startTime: 2000 }, undefined)).toBe(false);
  });
});

describe('orphan tree traversal', () => {
  const nodes = [
    { id: 'root', status: 'running' },
    { id: 'child-a', parentId: 'root', status: 'running' },
    { id: 'grandchild-a', parentId: 'child-a', status: 'running' },
    { id: 'child-b', parentId: 'root', status: 'running' },
    { id: 'detached', status: 'running' },
  ] as const;

  it('按 parent→children DFS 收集全部后代，不包含兄弟与自身', () => {
    expect(collectDescendantAgentIds(nodes, 'root')).toEqual([
      'child-a',
      'grandchild-a',
      'child-b',
    ]);
    expect(collectDescendantAgentIds(nodes, 'child-a')).toEqual(['grandchild-a']);
  });

  it('父节点已死但子仍在跑时，标出整棵孤儿子树', () => {
    const orphaned = collectRunningOrphanAgentIds([
      { id: 'root', status: 'completed' },
      { id: 'child-a', parentId: 'root', status: 'running' },
      { id: 'grandchild-a', parentId: 'child-a', status: 'running' },
      { id: 'child-b', parentId: 'root', status: 'completed' },
      { id: 'grandchild-b', parentId: 'child-b', status: 'running' },
      { id: 'sibling-root', status: 'running' },
    ]);

    expect(orphaned).toEqual(['child-a', 'grandchild-a', 'grandchild-b']);
  });
});
