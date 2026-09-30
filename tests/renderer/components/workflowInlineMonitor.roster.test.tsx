// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ScriptRunAgentSnapshot, ScriptRunAgentStatus, ScriptRunSnapshot } from '../../../src/shared/contract/scriptRun';
import { buildWorkflowTimeline } from '../../../src/renderer/utils/workflowTimeline';
import { buildWorkflowTaskRecord } from '../../../src/renderer/hooks/useRunWorkbenchModel';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn().mockResolvedValue(undefined) },
}));

import { WorkflowInlineMonitor } from '../../../src/renderer/components/features/workflow/WorkflowInlineMonitor';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkflowStore } from '../../../src/renderer/stores/workflowStore';

const PHASE_HEADER_CLASS = ['px-3', 'py-1', 'text-zinc-500', 'font-medium', 'uppercase', 'tracking-wide', 'text-[10px]'];

function rosterSnapshot(): ScriptRunSnapshot {
  const agents: ScriptRunAgentSnapshot[] = Array.from({ length: 16 }, (_, index) => {
    const status: ScriptRunAgentStatus = index < 11 ? 'done' : index < 14 ? 'error' : 'running';
    return { id: `agent-${index}`, label: `agent-${index}`, phase: 'read', status };
  });
  return {
    runId: 'wf-roster',
    sessionId: 'session-roster',
    status: 'running',
    goal: 'read images',
    phases: ['read'],
    logs: [],
    agents,
    runningCount: 99,
    doneCount: 98,
    errorCount: 97,
  };
}

function classText(element: Element): string {
  return typeof element.className === 'string' ? element.className : (element.getAttribute('class') ?? '');
}

describe('WorkflowInlineMonitor roster', () => {
  beforeEach(() => {
    useWorkflowStore.getState().clear();
    useSessionStore.setState({ currentSessionId: 'session-roster' });
  });

  afterEach(() => cleanup());

  it('folds a 16-agent phase to five rows plus one more row, and shares timeline totals', () => {
    const snapshot = rosterSnapshot();
    useWorkflowStore.setState({
      runs: { 'wf-roster': snapshot },
      activeRunId: 'wf-roster',
    });

    const view = render(<WorkflowInlineMonitor />);
    const totals = buildWorkflowTimeline(snapshot).totals;
    expect(totals).toEqual({ phaseCount: 1, agentCount: 16, running: 2, done: 11, error: 3 });

    expect(view.getByText(`${totals.running} running`)).toBeTruthy();
    expect(view.getByText(`${totals.done} done`)).toBeTruthy();
    expect(view.getByText(`${totals.error} error`)).toBeTruthy();
    expect(view.queryByText('99 running')).toBeNull();
    expect(view.queryByText('98 done')).toBeNull();
    expect(view.queryByText('97 error')).toBeNull();

    const record = buildWorkflowTaskRecord(snapshot);
    expect(record?.steps[1]?.title).toBe(
      `${totals.running} 执行中 · ${totals.done} 已完成 · ${totals.error} 执行失败`,
    );

    const phaseBlocks = Array.from(view.container.querySelectorAll('div')).filter((element) => (
      classText(element).split(/\s+/).includes('py-0.5')
    ));
    expect(phaseBlocks).toHaveLength(1);
    const children = Array.from(phaseBlocks[0].children);
    const agentRows = children.filter((element) => element.classList.contains('pl-5'));
    const more = children.find((element) => element.textContent === '+11 more');
    expect(agentRows).toHaveLength(5);
    expect(more).toBeTruthy();
    expect(agentRows.length + 1).toBeLessThanOrEqual(6);
    const moreClass = classText(more!).split(/\s+/);
    for (const token of PHASE_HEADER_CLASS) expect(moreClass).toContain(token);

    expect(view.getByText('agent-14')).toBeTruthy();
    expect(view.getByText('agent-15')).toBeTruthy();
    expect(view.getByText('agent-11')).toBeTruthy();
    expect(view.queryByText('agent-0')).toBeNull();

    const scroll = view.container.querySelector('.max-h-64');
    expect(classText(scroll!)).toContain('overflow-y-auto');
    for (const element of view.container.querySelectorAll('*')) {
      expect(classText(element)).not.toContain('overflow-x');
      expect(element.getAttribute('style') ?? '').not.toMatch(/(^|;)\s*width\s*:/i);
    }
  });
});
