// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CronJobExecution } from '../../../src/shared/contract/cron';
import { CronExecutionList } from '../../../src/renderer/components/features/cron/CronExecutionList';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';

const execution: CronJobExecution = {
  id: 'execution-cloud',
  jobId: 'job-cloud',
  runsOn: 'cloud',
  status: 'failed',
  scheduledAt: 1,
  startedAt: 1,
  completedAt: 2,
  duration: 1,
  retryAttempt: 0,
  error: 'Cloud execution is not wired yet (N-L3-MINLOOP-SRV).',
};

afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

describe('cron execution location presentation', () => {
  it('adds the location column without merging run timelines', () => {
    render(
      <CronExecutionList
        executions={[execution]}
        selectedExecutionId={execution.id}
        onSelectExecution={() => undefined}
        jobNameById={{ [execution.jobId]: '云端任务' }}
        runsOnByJobId={{ [execution.jobId]: 'cloud' }}
      />,
    );

    expect(screen.getByText('位置')).toBeTruthy();
    expect(screen.getByTestId('cron-runs-on-pill-cloud').textContent).toContain('云端');
  });

  it('shows execution location and localizes the host error in the detail card', () => {
    render(<CronExecutionDetail execution={execution} runsOn="cloud" />);

    expect(screen.getByText('执行位置')).toBeTruthy();
    expect(screen.getByTestId('cron-runs-on-pill-cloud').textContent).toContain('云端');
    expect(screen.getByText('云端执行尚未接线（N-L3-MINLOOP-SRV）')).toBeTruthy();
  });
});


describe('N-CRON-ACTIONGATE unsupported action message', () => {
  it.each([
    ['zh', '该类任务暂不支持'],
    ['en', 'This task type is not supported yet.'],
  ] as const)('%s 展示不支持原因', (language, message) => {
    useAppStore.setState({ language });
    render(<CronExecutionDetail execution={{ ...execution, runsOn: 'local', error: 'unsupported_action' }} />);
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText('unsupported_action')).toBeNull();
  });
});
