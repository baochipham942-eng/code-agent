// @vitest-environment jsdom
// N-CRON-RUN-LEDGER-VISIBLE-FU1-SHOTS：英文运行记录表在 1440x900 下比滚动容器宽 83px，
// 把「重试 / 退出码」挤出可视区。jsdom 不排版，这里钉住造成溢出的两个类：
// 表头不得 uppercase（英文大写表头最宽），任务名列上限不得超过 200px。
// 真实宽度由 headless 截图脚本量（证据档 ②）。
import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: vi.fn() } }));
import { CronExecutionList } from '../../../src/renderer/components/features/cron/CronExecutionList';

afterEach(cleanup);

describe('CronExecutionList 英文表头宽度', () => {
  it('表头不 uppercase、任务名列 max-w ≤200px，保证 Retries / Exit code 留在可视区', () => {
    const { container } = render(
      <CronExecutionList
        executions={[{
          id: 'e1', jobId: 'j1', runsOn: 'local', status: 'completed', scheduledAt: 1, startedAt: 1,
          completedAt: 2, duration: 1, retryAttempt: 0,
        }]}
        selectedExecutionId={null}
        onSelectExecution={() => undefined}
        jobNameById={{ j1: '[Cadence] ledger-role-c' }}
        runsOnByJobId={{ j1: 'local' }}
      />,
    );
    expect(container.querySelector('thead')?.className).not.toMatch(/uppercase/);
    const jobCell = screen.getByText('[Cadence] ledger-role-c');
    const max = /max-w-\[(\d+)px\]/.exec(jobCell.className);
    expect(max).not.toBeNull();
    expect(Number(max![1])).toBeLessThanOrEqual(200);
  });

  it('运行记录工作台给列表 2fr、详情 1fr（1440 宽下列表 ≥720px，英文表 720px 放得下）', () => {
    const src = readFileSync('src/renderer/components/features/cron/CronCenterPanel.tsx', 'utf8');
    expect(src).toContain('grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]');
  });
});
