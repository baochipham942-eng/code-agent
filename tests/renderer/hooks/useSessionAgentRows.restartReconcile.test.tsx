// @vitest-environment jsdom
// ============================================================================
// useSessionAgentRows 重启收口回归（N-STALE-AGENT-CHIP-AFTER-QUIT A）
// 宿主在数据源头把「上一进程遗留、无活进程」的行收成 cancelled 后，行模型必须
// 不再把它计为 working；真正活着的行维持 working（unknown=宁可在干的口径不变）。
// ============================================================================
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';

const runtime = vi.hoisted(() => ({
  members: [] as Array<{
    key: string;
    roleId: string;
    name: string;
    status: 'standby' | 'running' | 'completed' | 'failed' | 'cancelled';
    isLead: boolean;
  }>,
  snapshot: null as AgentTreeSnapshot | null,
}));

vi.mock('../../../src/renderer/components/features/expert/SessionMemberBar', () => ({
  useSessionMembers: () => runtime.members,
}));

vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: runtime.snapshot, refresh: async () => {} }),
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: never[] }) => unknown) =>
    selector({ tasks: [] }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: {
    pendingPermissionRequest: null;
    pendingPermissionSessionId: string | null;
    queuedPermissionRequests: Record<string, never[]>;
    activeAgentId: string | null;
  }) => unknown) => selector({
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    queuedPermissionRequests: {},
    activeAgentId: null,
  }),
}));

import { useSessionAgentRows } from '../../../src/renderer/hooks/useSessionAgentRows';

function treeNode(id: string, status: AgentTreeSnapshot['nodes'][number]['status']) {
  return {
    id,
    role: id,
    status,
    statusLabel: status,
    children: [],
    worktreeState: { status: 'none' as const },
    budgetSummary: {},
    evidenceRefs: [],
    // subagentContext 不是 UNANCHORED_SOURCES，节点凭它锚定在本会话
    sources: ['subagentContext' as const],
  };
}

function rowsFor(snapshot: AgentTreeSnapshot) {
  runtime.snapshot = snapshot;
  return renderHook(() => useSessionAgentRows('session-1')).result.current.rows;
}

describe('useSessionAgentRows restart reconciliation', () => {
  afterEach(() => {
    cleanup();
    runtime.members = [];
    runtime.snapshot = null;
  });

  it('does not count a post-restart cancelled node (no live process) as working', () => {
    const rows = rowsFor({
      generatedAt: 1,
      sessionId: 'session-1',
      roots: [],
      nodes: [treeNode('ghost-agent', 'cancelled')],
      summary: {
        total: 1,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 1,
        blocked: 0,
        withWorktree: 0,
        ownershipConflicts: [],
      },
    });

    const ghost = rows.find((row) => row.key === 'ghost-agent');
    expect(ghost?.status).toBe('cancelled');
    expect(rows.filter((row) => row.status === 'working')).toHaveLength(0);
  });

  it('keeps a genuinely live running node working, and keeps the unknown→working policy for fresh in-process rows', () => {
    const rows = rowsFor({
      generatedAt: 1,
      sessionId: 'session-1',
      roots: [],
      nodes: [treeNode('live-agent', 'running'), treeNode('fresh-unknown', 'unknown')],
      summary: {
        total: 2,
        running: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        blocked: 0,
        withWorktree: 0,
        ownershipConflicts: [],
      },
    });

    expect(rows.find((row) => row.key === 'live-agent')?.status).toBe('working');
    expect(rows.find((row) => row.key === 'fresh-unknown')?.status).toBe('working');
  });
});
