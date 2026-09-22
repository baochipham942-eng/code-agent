// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EvalRunCaseResults } from '@internal-evaluation/renderer/evalCenter/EvalRunCaseResults';
import { evalRunPanelZh } from '@internal-evaluation/renderer/i18n/evalRunPanel';

afterEach(cleanup);

describe('EvalRunCaseResults 零区分度灰标', () => {
  it('在 alwaysPassedCaseIds 里的题带「5 轮全过」，其他题不带', () => {
    render(
      <EvalRunCaseResults
        runId="run-1"
        caseResults={{ always: { status: 'passed', score: 1 }, flaky: { status: 'passed', score: 1 } }}
        labels={evalRunPanelZh.runPanel}
        alwaysPassedCaseIds={new Set(['always'])}
        onOpenCase={() => undefined}
      />,
    );
    const marks = screen.getAllByTestId('benchmark-run-case-always-passed');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('5 轮全过');
    expect(screen.getByTestId('benchmark-run-case-run-1-always').textContent).toContain('5 轮全过');
    expect(screen.getByTestId('benchmark-run-case-run-1-flaky').textContent).not.toContain('5 轮全过');
  });
});
