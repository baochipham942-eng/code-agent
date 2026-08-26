// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { TurnSegment } from '../../../src/renderer/components/TaskPanel/SessionInspector/model';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({
    resolvedPermissionRequests: {},
    openPreview: vi.fn(),
    openSettingsTab: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: unknown) => unknown) => selector({ sendPrompt: vi.fn() }),
}));

import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { TurnRow } from '../../../src/renderer/components/TaskPanel/SessionInspector/turnRow';
import { SidebarStatusFilterDropdown } from '../../../src/renderer/components/features/sidebar/SidebarStatusFilterDropdown';

const INTERNAL_TOOL_ID = /\b[a-z]+[A-Z][A-Za-z]+\b/;
const PERSISTED_MARKER = /\[(?:cancelled|aborted|interrupted|pending)[^\]]*\]/i;

function expectHumanFacing(text: string): void {
  expect(text).not.toMatch(INTERNAL_TOOL_ID);
  expect(text).not.toMatch(PERSISTED_MARKER);
}

function timelineNode(): TraceNode {
  return {
    id: 'timeline-tool',
    type: 'tool_call',
    content: '',
    timestamp: 1,
    toolCall: {
      id: 'timeline-call',
      name: 'futureCamelTool',
      args: {},
      success: false,
      result: '[cancelled] VendorRouterError',
    },
  } as TraceNode;
}

function taskPanelSegment(): TurnSegment {
  return {
    index: 1,
    events: [],
    stamp: null,
    inProgress: false,
    toolDispatches: [
      { toolName: 'TaskManager', success: true, durationMs: 8, error: null, fromCache: false, bucket: 'other' },
      {
        toolName: 'futureCamelTool',
        success: false,
        durationMs: 12,
        error: '[cancelled] VendorRouterError at internal.ts:18',
        fromCache: false,
        bucket: 'other',
      },
    ],
    decisions: [],
    inferences: [],
    manifests: [],
    verificationCount: 0,
    verificationSkippedCount: 0,
    compactionCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0 },
    toolCounts: { read: 0, write: 0, command: 0, browser: 0, other: 2 },
    failedToolCount: 1,
    tokenAnomaly: false,
    lastToolBucket: 'other',
    inferenceCalls: [],
    orphanToolDispatches: [],
    startedAt: null,
    endedAt: null,
  };
}

function renderSidebar(showTrajectoryFilters: boolean) {
  return render(
    <SidebarStatusFilterDropdown
      statusFilterOpen
      setStatusFilterOpen={vi.fn()}
      statusFilterRef={React.createRef<HTMLDivElement>()}
      visibleStatusFilterOptions={[{ id: 'all', label: '全部' }]}
      sessionStatusFilter="all"
      setSessionStatusFilter={vi.fn()}
      trajectoryTierFilter="all"
      setTrajectoryTierFilter={vi.fn()}
      trajectoryFailureFilter="all"
      setTrajectoryFailureFilter={vi.fn()}
      trajectoryReviewFilter="all"
      setTrajectoryReviewFilter={vi.fn()}
      hasActiveTrajectoryFilter={false}
      hasActiveStatusDropdownFilter={false}
      activeStatusFilterLabel="全部"
      showTrajectoryFilters={showTrajectoryFilters}
    />,
  );
}

describe('renderer human-pipe consumer contract', () => {
  it('时间线主行、任务面板行、侧栏筛选标签均不暴露工具 ID 或落库标记', () => {
    const timeline = render(<ToolStepGroup nodes={[timelineNode()]} />);
    expectHumanFacing(timeline.container.textContent ?? '');
    timeline.unmount();

    const taskPanel = render(<TurnRow segment={taskPanelSegment()} />);
    fireEvent.click(screen.getByTestId('inspector-activity-detail-toggle'));
    expectHumanFacing(screen.getByTestId('inspector-activity-detail').textContent ?? '');
    taskPanel.unmount();

    const sidebar = renderSidebar(true);
    expectHumanFacing(sidebar.container.textContent ?? '');
    expect(sidebar.container.textContent).toContain('会话质量复核');
    expect(sidebar.container.textContent).not.toMatch(/\bG[012]\b/);
    expect(sidebar.container.textContent).not.toContain('missing_tool_result');
  });

  it('Trajectory 筛选只向管理员开放', () => {
    const sidebar = renderSidebar(false);
    expect(sidebar.container.textContent).not.toContain('会话质量复核');
    expect(sidebar.container.textContent).not.toContain('需要诊断');
    expect(sidebar.container.textContent).not.toContain('有步骤没有返回结果');
  });
});
