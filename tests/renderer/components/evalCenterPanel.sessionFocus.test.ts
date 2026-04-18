import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const appState = {
  showEvalCenter: true,
  evalCenterSessionId: 'session-focus-1',
  setShowEvalCenter: vi.fn(),
};

const reactState = vi.hoisted(() => ({
  stateCallCount: 0,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (initial: unknown) => {
      reactState.stateCallCount += 1;
      if (reactState.stateCallCount === 1) {
        return ['sessions', vi.fn()] as const;
      }
      if (reactState.stateCallCount === 2) {
        return [appState.evalCenterSessionId, vi.fn()] as const;
      }
      return actual.useState(initial);
    },
    useEffect: vi.fn(),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
}));

vi.mock('../../../src/renderer/components/features/evalCenter/pages/SessionEvalView', () => ({
  SessionEvalView: ({ sessionId }: { sessionId: string }) => React.createElement('div', null, `session:${sessionId}`),
}));

vi.mock('../../../src/renderer/components/features/evalCenter/SessionListView', () => ({
  SessionListView: () => React.createElement('div', null, 'session-list'),
}));

vi.mock('../../../src/renderer/components/features/evalCenter/testResults/TestResultsDashboard', () => ({
  TestResultsDashboard: () => null,
}));

vi.mock('../../../src/renderer/components/features/evalCenter/pages/TestCaseManager', () => ({
  TestCaseManager: () => null,
}));

vi.mock('../../../src/renderer/components/features/evalCenter/pages/ScoringConfigPage', () => ({
  ScoringConfigPage: () => null,
}));

vi.mock('../../../src/renderer/components/features/evalCenter/pages/ExperimentDetailPage', () => ({
  ExperimentDetailPage: () => null,
}));

vi.mock('../../../src/renderer/components/features/evalCenter/pages/FailureAnalysisPage', () => ({
  FailureAnalysisPage: () => null,
}));

vi.mock('../../../src/renderer/components/features/evalCenter/pages/CrossExperimentPage', () => ({
  CrossExperimentPage: () => null,
}));

import { EvalCenterPanel } from '../../../src/renderer/components/features/evalCenter/EvalCenterPanel';

describe('EvalCenterPanel session focus', () => {
  it('renders the selected session view when eval center already carries a focused session id', () => {
    reactState.stateCallCount = 0;

    const html = renderToStaticMarkup(React.createElement(EvalCenterPanel));

    expect(html).toContain('评测中心');
    expect(html).toContain('session:session-focus-1');
    expect(html).not.toContain('session-list');
  });
});
