import { describe, expect, it } from 'vitest';
import type { DesktopActivityEvent } from '../../../src/shared/types';
import {
  buildDesktopActivitySlices,
  summarizeDesktopActivitySlice,
  deriveTodoCandidatesFromSlice,
  filterTodoCandidatesByFeedback,
  syncDesktopTodoCandidatesToTaskStore,
} from '../../../src/main/memory/desktopActivityUnderstandingService';
import { clearTasks, createTask, listTasks } from '../../../src/main/tools/planning/taskStore';

function makeEvent(overrides: Partial<DesktopActivityEvent>): DesktopActivityEvent {
  return {
    id: overrides.id || crypto.randomUUID(),
    capturedAtMs: overrides.capturedAtMs || Date.now(),
    appName: overrides.appName || 'Google Chrome',
    fingerprint: overrides.fingerprint || crypto.randomUUID(),
    bundleId: overrides.bundleId || null,
    windowTitle: overrides.windowTitle || null,
    browserUrl: overrides.browserUrl || null,
    browserTitle: overrides.browserTitle || null,
    documentPath: overrides.documentPath || null,
    sessionState: overrides.sessionState || null,
    idleSeconds: overrides.idleSeconds || null,
    powerSource: overrides.powerSource || null,
    onAcPower: overrides.onAcPower || null,
    batteryPercent: overrides.batteryPercent || null,
    batteryCharging: overrides.batteryCharging || null,
    screenshotPath: overrides.screenshotPath || null,
  };
}

describe('desktopActivityUnderstandingService', () => {
  it('buildDesktopActivitySlices groups events into fixed time buckets', () => {
    const events = [
      makeEvent({ capturedAtMs: Date.parse('2026-03-14T09:05:00+08:00') }),
      makeEvent({ capturedAtMs: Date.parse('2026-03-14T09:12:00+08:00') }),
      makeEvent({ capturedAtMs: Date.parse('2026-03-14T09:42:00+08:00') }),
    ];

    const slices = buildDesktopActivitySlices(events, 30);

    expect(slices).toHaveLength(2);
    expect(slices[0].events).toHaveLength(2);
    expect(slices[1].events).toHaveLength(1);
    expect(slices[0].sliceKey).not.toBe(slices[1].sliceKey);
  });

  it('summarizeDesktopActivitySlice extracts top apps and salient subjects', () => {
    const slice = buildDesktopActivitySlices([
      makeEvent({
        capturedAtMs: Date.parse('2026-03-14T09:05:00+08:00'),
        appName: 'Google Chrome',
        browserTitle: 'RFC-005 codex alignment - GitHub',
        browserUrl: 'https://github.com/openai/codex/issues/5',
      }),
      makeEvent({
        capturedAtMs: Date.parse('2026-03-14T09:11:00+08:00'),
        appName: 'Cursor',
        windowTitle: 'docs/plan/native-context-memory.md - Cursor',
        documentPath: '/tmp/docs/plan/native-context-memory.md',
      }),
      makeEvent({
        capturedAtMs: Date.parse('2026-03-14T09:18:00+08:00'),
        appName: 'Google Chrome',
        browserTitle: 'RFC-005 codex alignment - GitHub',
        browserUrl: 'https://github.com/openai/codex/pull/5',
      }),
    ], 30)[0];

    const summary = summarizeDesktopActivitySlice(slice);

    expect(summary.eventCount).toBe(3);
    expect(summary.topApps[0]?.appName).toBe('Google Chrome');
    expect(summary.salientSubjects.some((subject) => /rfc-005|native-context-memory/i.test(subject))).toBe(true);
    expect(summary.summary).toContain('共 3 条桌面事件');
  });

  it('deriveTodoCandidatesFromSlice generates actionable follow-ups from strong subjects', () => {
    const slice = buildDesktopActivitySlices([
      makeEvent({
        capturedAtMs: Date.parse('2026-03-14T10:05:00+08:00'),
        appName: 'Google Chrome',
        browserTitle: 'Fix memory regression issue #42 - GitHub',
        browserUrl: 'https://github.com/example/repo/issues/42',
      }),
      makeEvent({
        capturedAtMs: Date.parse('2026-03-14T10:12:00+08:00'),
        appName: 'Cursor',
        windowTitle: 'memory-regression-fix.ts - Cursor',
        documentPath: '/tmp/memory-regression-fix.ts',
      }),
      makeEvent({
        capturedAtMs: Date.parse('2026-03-14T10:18:00+08:00'),
        appName: 'Google Chrome',
        browserTitle: 'Fix memory regression issue #42 - GitHub',
        browserUrl: 'https://github.com/example/repo/issues/42',
      }),
    ], 30)[0];

    const summary = summarizeDesktopActivitySlice(slice);
    const todos = deriveTodoCandidatesFromSlice(slice, summary);

    expect(todos.length).toBeGreaterThan(0);
    expect(todos[0].confidence).toBeGreaterThan(0.55);
    expect(todos.some((todo) => /跟进|继续处理|继续完善/.test(todo.content))).toBe(true);
  });

  it('syncDesktopTodoCandidatesToTaskStore creates stable session tasks without duplicates', () => {
    const sessionId = `desktop-sync-${crypto.randomUUID()}`;
    clearTasks(sessionId);

    const candidates = [
      {
        id: 'slice-1:跟进 issue #42',
        sliceKey: 'slice-1',
        content: '跟进 issue #42',
        activeForm: '正在跟进 issue #42',
        status: 'pending' as const,
        confidence: 0.82,
        evidence: ['issue #42 - GitHub'],
        createdAtMs: Date.parse('2026-03-14T10:18:00+08:00'),
      },
    ];

    const first = syncDesktopTodoCandidatesToTaskStore(sessionId, candidates);
    expect(first.created).toHaveLength(1);
    expect(first.updated).toHaveLength(0);
    expect(first.tasks).toHaveLength(1);
    expect(first.tasks[0]?.metadata?.source).toBe('desktop_activity');
    expect(first.tasks[0]?.metadata?.desktopTodoKey).toBe(candidates[0].id);

    const second = syncDesktopTodoCandidatesToTaskStore(sessionId, candidates);
    expect(second.created).toHaveLength(0);
    expect(second.updated).toHaveLength(0);
    expect(listTasks(sessionId)).toHaveLength(1);

    clearTasks(sessionId);
  });

  it('syncDesktopTodoCandidatesToTaskStore marks same-subject existing tasks as superseding candidates', () => {
    const sessionId = `desktop-supersede-${crypto.randomUUID()}`;
    clearTasks(sessionId);

    createTask(sessionId, {
      subject: '跟进 issue #42',
      description: 'manually created task',
    });

    const result = syncDesktopTodoCandidatesToTaskStore(sessionId, [
      {
        id: 'slice-1:跟进 issue #42',
        sliceKey: 'slice-1',
        content: '跟进 issue #42',
        activeForm: '正在跟进 issue #42',
        status: 'pending' as const,
        confidence: 0.82,
        evidence: ['issue #42 - GitHub'],
        createdAtMs: Date.now(),
      },
    ]);

    expect(result.created).toHaveLength(0);
    expect(result.supersededTodoKeys).toEqual(['slice-1:跟进 issue #42']);

    clearTasks(sessionId);
  });

  it('filterTodoCandidatesByFeedback hides completed or dismissed todo keys', () => {
    const candidates = [
      {
        id: 'slice-1:跟进 issue #42',
        sliceKey: 'slice-1',
        content: '跟进 issue #42',
        activeForm: '正在跟进 issue #42',
        status: 'pending' as const,
        confidence: 0.82,
        evidence: ['issue #42 - GitHub'],
        createdAtMs: Date.parse('2026-03-14T10:18:00+08:00'),
      },
      {
        id: 'slice-2:继续完善 RFC-005',
        sliceKey: 'slice-2',
        content: '继续完善 RFC-005',
        activeForm: '正在完善 RFC-005',
        status: 'pending' as const,
        confidence: 0.77,
        evidence: ['RFC-005 - GitHub'],
        createdAtMs: Date.parse('2026-03-14T11:18:00+08:00'),
      },
    ];

    const visible = filterTodoCandidatesByFeedback(candidates, [
      {
        todoKey: 'slice-1:跟进 issue #42',
        status: 'completed',
        source: 'task',
        updatedAtMs: Date.now(),
      },
    ]);

    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe('slice-2:继续完善 RFC-005');
  });

  it('filterTodoCandidatesByFeedback temporarily suppresses recently accepted todo keys', () => {
    const now = Date.now();
    const candidates = [
      {
        id: 'slice-1:跟进 issue #42',
        sliceKey: 'slice-1',
        content: '跟进 issue #42',
        activeForm: '正在跟进 issue #42',
        status: 'pending' as const,
        confidence: 0.82,
        evidence: ['issue #42 - GitHub'],
        createdAtMs: now,
      },
    ];

    expect(filterTodoCandidatesByFeedback(candidates, [
      {
        todoKey: 'slice-1:跟进 issue #42',
        status: 'accepted',
        source: 'task',
        updatedAtMs: now,
      },
    ])).toHaveLength(0);

    expect(filterTodoCandidatesByFeedback(candidates, [
      {
        todoKey: 'slice-1:跟进 issue #42',
        status: 'accepted',
        source: 'task',
        updatedAtMs: now - (3 * 60 * 60 * 1000),
      },
    ])).toHaveLength(1);
  });

  it('filterTodoCandidatesByFeedback suppresses snoozed and superseded todo keys until resumeAtMs', () => {
    const now = Date.now();
    const candidates = [
      {
        id: 'slice-1:跟进 issue #42',
        sliceKey: 'slice-1',
        content: '跟进 issue #42',
        activeForm: '正在跟进 issue #42',
        status: 'pending' as const,
        confidence: 0.82,
        evidence: ['issue #42 - GitHub'],
        createdAtMs: now,
      },
    ];

    expect(filterTodoCandidatesByFeedback(candidates, [
      {
        todoKey: 'slice-1:跟进 issue #42',
        status: 'snoozed',
        source: 'task',
        resumeAtMs: now + (6 * 60 * 60 * 1000),
        updatedAtMs: now,
      },
    ])).toHaveLength(0);

    expect(filterTodoCandidatesByFeedback(candidates, [
      {
        todoKey: 'slice-1:跟进 issue #42',
        status: 'superseded',
        source: 'sync',
        resumeAtMs: now - 1000,
        updatedAtMs: now,
      },
    ])).toHaveLength(1);
  });
});
