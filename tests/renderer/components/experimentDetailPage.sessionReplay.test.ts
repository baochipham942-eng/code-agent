import React from 'react';
import { describe, expect, it, vi } from 'vitest';

const setShowEvalCenterMock = vi.hoisted(() => vi.fn());

const experiment = {
  id: 'experiment-1',
  name: 'Replay experiment',
  model: 'gpt-5.4',
  status: 'failed',
  created_at: 1_764_246_000_000,
  cases: [
    {
      id: 'case-row-1',
      case_id: 'case-1',
      session_id: 'session-replay-1',
      status: 'failed',
      score: 42,
      duration_ms: 1200,
      data_json: '{}',
    },
  ],
};

const report = {
  total: 1,
  passed: 0,
  failed: 1,
  skipped: 0,
  averageScore: 0.42,
  results: [],
  startTime: experiment.created_at,
  duration: 1200,
  performance: {
    avgResponseTime: 1200,
    maxResponseTime: 1200,
    totalToolCalls: 0,
    totalTurns: 0,
  },
};

const reactState = vi.hoisted(() => ({
  stateCallCount: 0,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useEffect: vi.fn(),
    useState: (initial: unknown) => {
      reactState.stateCallCount += 1;
      switch (reactState.stateCallCount) {
        case 1:
          return ['cases', vi.fn()] as const;
        case 2:
          return [report, vi.fn()] as const;
        case 3:
          return [false, vi.fn()] as const;
        case 4:
          return [null, vi.fn()] as const;
        case 5:
          return [experiment, vi.fn()] as const;
        case 6:
          return [false, vi.fn()] as const;
        case 7:
          return [null, vi.fn()] as const;
        default:
          return actual.useState(initial);
      }
    },
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: { setShowEvalCenter: typeof setShowEvalCenterMock }) => unknown) =>
    selector ? selector({ setShowEvalCenter: setShowEvalCenterMock }) : { setShowEvalCenter: setShowEvalCenterMock },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/components/features/evalCenter/testResults/TestResultsDashboard', () => ({
  TestResultsDashboard: () => null,
}));

vi.mock('../../../src/renderer/components/features/evalCenter/pages/CaseDetailPage', () => ({
  CaseDetailPage: () => null,
}));

import { ExperimentDetailPage } from '../../../src/renderer/components/features/evalCenter/pages/ExperimentDetailPage';

type ButtonElement = React.ReactElement<{
  children?: React.ReactNode;
  onClick?: () => void;
}>;

function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return nodeText(props.children);
  }
  return '';
}

function findButtonByText(node: React.ReactNode, text: string): ButtonElement | null {
  if (!React.isValidElement(node)) return null;
  const props = node.props as { children?: React.ReactNode };
  if (node.type === 'button' && nodeText(props.children).trim() === text) {
    return node as ButtonElement;
  }
  for (const child of React.Children.toArray(props.children)) {
    const found = findButtonByText(child, text);
    if (found) return found;
  }
  return null;
}

describe('ExperimentDetailPage session replay navigation', () => {
  it('opens Eval Center on the experiment case session instead of dispatching a dead event', () => {
    reactState.stateCallCount = 0;
    setShowEvalCenterMock.mockReset();

    const tree = ExperimentDetailPage({ experimentId: 'experiment-1' });
    const viewButton = findButtonByText(tree, '查看');

    expect(viewButton).toBeTruthy();
    viewButton?.props.onClick?.();

    expect(setShowEvalCenterMock).toHaveBeenCalledWith(true, undefined, 'session-replay-1');
  });
});
