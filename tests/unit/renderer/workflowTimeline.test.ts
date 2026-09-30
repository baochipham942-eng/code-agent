import { describe, expect, it } from 'vitest';
import type { ScriptRunAgentSnapshot, ScriptRunAgentStatus, ScriptRunSnapshot } from '../../../src/shared/contract/scriptRun';
import {
  buildWorkflowTimeline,
  WORKFLOW_TIMELINE_NO_PHASE,
} from '../../../src/renderer/utils/workflowTimeline';

function agent(id: string, status: ScriptRunAgentStatus, phase?: string): ScriptRunAgentSnapshot {
  return { id, label: id, status, ...(phase === undefined ? {} : { phase }) };
}

function agentsInPhase(count: number, status: ScriptRunAgentStatus = 'done', phase = 'read'): ScriptRunAgentSnapshot[] {
  return Array.from({ length: count }, (_, index) => agent(`a${index}`, status, phase));
}

function snapshot(agents: ScriptRunAgentSnapshot[], phases: string[] = ['read']): ScriptRunSnapshot {
  return {
    runId: 'run-1',
    status: 'running',
    phases,
    logs: [],
    agents,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

describe('buildWorkflowTimeline roster', () => {
  it('shows six agents and folds seven, sixteen, and three hundred', () => {
    const cases = [
      { count: 6, shown: 6, hidden: 0 },
      { count: 7, shown: 5, hidden: 2 },
      { count: 16, shown: 5, hidden: 11 },
      { count: 300, shown: 5, hidden: 295 },
    ] as const;
    for (const { count, shown, hidden } of cases) {
      const timeline = buildWorkflowTimeline(snapshot(agentsInPhase(count)));
      expect(timeline.phases).toHaveLength(1);
      expect(timeline.phases[0].pinned).toHaveLength(shown);
      expect(timeline.phases[0].hiddenCount).toBe(hidden);
      expect(timeline.phases[0].total).toBe(count);
      expect(timeline.totals.agentCount).toBe(count);
      expect(timeline.phases[0].pinned.length + timeline.phases[0].hiddenCount).toBe(count);
    }
  });

  it('keeps six or fewer agents in participant order even when a previous pin exists', () => {
    const statuses: ScriptRunAgentStatus[] = ['done', 'running', 'error', 'queued', 'skipped', 'done'];
    const list = statuses.map((status, index) => agent(`a${index}`, status, 'read'));
    const phase = buildWorkflowTimeline(snapshot(list), { read: ['a5'] }).phases[0];
    expect(phase.pinned.map((item) => item.id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    expect(phase.hiddenCount).toBe(0);
  });

  it('pins running before error before the rest, in participant order within a tier', () => {
    const statuses: ScriptRunAgentStatus[] = ['done', 'running', 'queued', 'error', 'skipped', 'running', 'done', 'error'];
    const list = statuses.map((status, index) => agent(`a${index}`, status, 'read'));
    const phase = buildWorkflowTimeline(snapshot(list)).phases[0];
    expect(phase.pinned.map((item) => item.id)).toEqual(['a1', 'a5', 'a3', 'a7', 'a0']);
    expect(phase.hiddenCount).toBe(3);
  });

  it('replaces exactly one pin when two agents change state', () => {
    const before = agentsInPhase(8);
    const first = buildWorkflowTimeline(snapshot(before));
    const prev = { read: first.phases[0].pinned.map((item) => item.id) };
    expect(prev.read).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);

    const nextAgents = before.map((item) => ({ ...item }));
    nextAgents[5].status = 'running';
    nextAgents[6].status = 'running';
    const second = buildWorkflowTimeline(snapshot(nextAgents), prev);
    const nextIds = second.phases[0].pinned.map((item) => item.id);
    expect(nextIds.filter((id) => !prev.read.includes(id))).toEqual(['a5']);
    expect(prev.read.filter((id) => !nextIds.includes(id))).toEqual(['a4']);
    expect(nextIds).toEqual(['a0', 'a1', 'a2', 'a3', 'a5']);
  });

  it('refills up to five when previous pins have left, without a second swap', () => {
    const list = agentsInPhase(8);
    list[0].status = 'running';
    list[1].status = 'running';
    const phase = buildWorkflowTimeline(snapshot(list), { read: ['gone', 'a7', 'a6', 'a5', 'a4'] }).phases[0];
    expect(phase.pinned.map((item) => item.id)).toEqual(['a7', 'a6', 'a5', 'a4', 'a0']);
    expect(phase.hiddenCount).toBe(3);
    expect(phase.total).toBe(8);
  });

  it('counts four running and three hundred done agents in a phase total of 304', () => {
    const list = [
      ...Array.from({ length: 4 }, (_, index) => agent(`run-${index}`, 'running', 'read')),
      ...Array.from({ length: 300 }, (_, index) => agent(`done-${index}`, 'done', 'read')),
    ];
    const phase = buildWorkflowTimeline(snapshot(list)).phases[0];
    expect(phase.counts).toEqual({ running: 4, done: 300, error: 0, queued: 0, skipped: 0 });
    expect(phase.total).toBe(304);
    expect(phase.pinned).toHaveLength(5);
    expect(phase.hiddenCount).toBe(299);
    expect(phase.pinned.length + phase.hiddenCount).toBe(304);
    expect(buildWorkflowTimeline(snapshot(list)).totals.agentCount).toBe(304);
  });

  it('orders declared phases, then undeclared phases, then agents without a phase', () => {
    const list = [
      agent('u1', 'done', 'later'),
      agent('n1', 'running'),
      agent('d1', 'error', 'declared'),
      agent('u2', 'queued', 'later'),
      agent('d2', 'done', 'declared'),
    ];
    const timeline = buildWorkflowTimeline(snapshot(list, ['declared', 'empty']));
    expect(timeline.phases.map((phase) => phase.name)).toEqual(['declared', 'later', WORKFLOW_TIMELINE_NO_PHASE]);
    expect(timeline.phases.map((phase) => phase.pinned.map((item) => item.id))).toEqual([
      ['d1', 'd2'],
      ['u1', 'u2'],
      ['n1'],
    ]);
    expect(timeline.totals).toEqual({ phaseCount: 3, agentCount: 5, running: 1, done: 2, error: 1 });
  });

  it('keeps queued and skipped out of the running, done, and error totals', () => {
    const list = (['running', 'done', 'error', 'queued', 'skipped'] as ScriptRunAgentStatus[])
      .map((status, index) => agent(`a${index}`, status, 'read'));
    const timeline = buildWorkflowTimeline(snapshot(list));
    expect(timeline.phases[0].counts).toEqual({ running: 1, done: 1, error: 1, queued: 1, skipped: 1 });
    expect(timeline.totals).toEqual({ phaseCount: 1, agentCount: 5, running: 1, done: 1, error: 1 });
  });
});
