import { describe, expect, it } from 'vitest';
import type {
  SessionTask,
  TaskCompleteData,
  TaskProgressData,
  TodoItem,
} from '../../../src/shared/contract';
import {
  applyTaskProgressEvent,
  type TaskProgressEventDeps,
} from '../../../src/renderer/hooks/agent/effects/useTaskProgressEffects';

interface TaskProgressState {
  currentSessionId: string | null;
  lastEventAt: number;
  sessionTaskComplete: Record<string, TaskCompleteData | null>;
  sessionTaskProgress: Record<string, TaskProgressData | null>;
  sessionTasks: SessionTask[];
  todos: TodoItem[];
  unreadSessionIds: string[];
}

function todo(content: string): TodoItem {
  return {
    content,
    status: 'pending',
    activeForm: `Working on ${content}`,
  };
}

function task(id: string): SessionTask {
  return {
    id,
    subject: `Task ${id}`,
    description: `Description ${id}`,
    activeForm: `Working on ${id}`,
    status: 'pending',
    priority: 'normal',
    blocks: [],
    blockedBy: [],
    metadata: {},
    createdAt: 100,
    updatedAt: 100,
  };
}

function progress(turnId: string): TaskProgressData {
  return {
    turnId,
    phase: 'tool_running',
    step: `Running ${turnId}`,
    progress: 50,
  };
}

function complete(turnId: string): TaskCompleteData {
  return {
    turnId,
    summary: `Completed ${turnId}`,
    duration: 250,
    toolsUsed: ['Read'],
  };
}

function createHarness(overrides: Partial<TaskProgressState> = {}) {
  const state: TaskProgressState = {
    currentSessionId: 'session-current',
    lastEventAt: 0,
    sessionTaskComplete: {},
    sessionTaskProgress: {},
    sessionTasks: [],
    todos: [],
    unreadSessionIds: [],
    ...overrides,
  };

  const deps: TaskProgressEventDeps = {
    debug: () => {},
    getCurrentSessionId: () => state.currentSessionId,
    markSessionUnread: (sessionId) => {
      state.unreadSessionIds.push(sessionId);
    },
    now: () => 500,
    setLastEventAt: (timestamp) => {
      state.lastEventAt = timestamp;
    },
    setSessionTaskComplete: (sessionId, value) => {
      state.sessionTaskComplete[sessionId] = value;
    },
    setSessionTaskProgress: (sessionId, value) => {
      state.sessionTaskProgress[sessionId] = value;
    },
    setSessionTasks: (tasks) => {
      state.sessionTasks = tasks;
    },
    setTodos: (todos) => {
      state.todos = todos;
    },
  };

  return { deps, state };
}

describe('applyTaskProgressEvent', () => {
  it('updates todos only for the current session while recording all todo activity', () => {
    const currentTodos = [todo('current')];
    const foreignTodos = [todo('foreign')];
    const { deps, state } = createHarness();

    applyTaskProgressEvent(
      { type: 'todo_update', data: currentTodos, sessionId: 'session-current' },
      deps,
    );
    applyTaskProgressEvent(
      { type: 'todo_update', data: foreignTodos, sessionId: 'session-foreign' },
      deps,
    );

    expect(state.lastEventAt).toBe(500);
    expect(state.todos).toEqual(currentTodos);
    expect(state.unreadSessionIds).toEqual([]);
  });

  it('updates session tasks only for the current session', () => {
    const currentTasks = [task('current')];
    const foreignTasks = [task('foreign')];
    const { deps, state } = createHarness();

    applyTaskProgressEvent(
      {
        type: 'task_update',
        data: { tasks: currentTasks, action: 'sync' },
        sessionId: 'session-current',
      },
      deps,
    );
    applyTaskProgressEvent(
      {
        type: 'task_update',
        data: { tasks: foreignTasks, action: 'sync' },
        sessionId: 'session-foreign',
      },
      deps,
    );

    expect(state.lastEventAt).toBe(500);
    expect(state.sessionTasks).toEqual(currentTasks);
    expect(state.unreadSessionIds).toEqual([]);
  });

  it('stores task progress by event session and clears prior completion state', () => {
    const nextProgress = progress('turn-foreign');
    const previousComplete = complete('turn-previous');
    const { deps, state } = createHarness({
      sessionTaskComplete: { 'session-foreign': previousComplete },
    });

    applyTaskProgressEvent(
      { type: 'task_progress', data: nextProgress, sessionId: 'session-foreign' },
      deps,
    );

    expect(state.lastEventAt).toBe(500);
    expect(state.sessionTaskProgress).toEqual({ 'session-foreign': nextProgress });
    expect(state.sessionTaskComplete).toEqual({ 'session-foreign': null });
    expect(state.unreadSessionIds).toEqual([]);
  });

  it('stores current-session completion and clears its progress without marking unread', () => {
    const previousProgress = progress('turn-current');
    const nextComplete = complete('turn-current');
    const { deps, state } = createHarness({
      sessionTaskProgress: { 'session-current': previousProgress },
    });

    applyTaskProgressEvent(
      { type: 'task_complete', data: nextComplete, sessionId: 'session-current' },
      deps,
    );

    expect(state.lastEventAt).toBe(500);
    expect(state.sessionTaskComplete).toEqual({ 'session-current': nextComplete });
    expect(state.sessionTaskProgress).toEqual({ 'session-current': null });
    expect(state.unreadSessionIds).toEqual([]);
  });

  it('stores foreign-session completion, clears its progress, and marks it unread', () => {
    const previousProgress = progress('turn-foreign');
    const nextComplete = complete('turn-foreign');
    const { deps, state } = createHarness({
      sessionTaskProgress: { 'session-foreign': previousProgress },
    });

    applyTaskProgressEvent(
      { type: 'task_complete', data: nextComplete, sessionId: 'session-foreign' },
      deps,
    );

    expect(state.lastEventAt).toBe(500);
    expect(state.sessionTaskComplete).toEqual({ 'session-foreign': nextComplete });
    expect(state.sessionTaskProgress).toEqual({ 'session-foreign': null });
    expect(state.unreadSessionIds).toEqual(['session-foreign']);
  });

  it('records handled activity but skips progress payloads without a session id', () => {
    const { deps, state } = createHarness();

    applyTaskProgressEvent(
      { type: 'task_progress', data: progress('turn-without-session') },
      deps,
    );

    expect(state.lastEventAt).toBe(500);
    expect(state.sessionTaskProgress).toEqual({});
    expect(state.sessionTaskComplete).toEqual({});
    expect(state.unreadSessionIds).toEqual([]);
  });

  it('leaves task state untouched for completion, cancellation, error, and stream end', () => {
    const existingProgress = progress('turn-existing');
    const existingComplete = complete('turn-complete');
    const existingTask = task('existing');
    const existingTodo = todo('existing');
    const { deps, state } = createHarness({
      lastEventAt: 41,
      sessionTaskComplete: { 'session-complete': existingComplete },
      sessionTaskProgress: { 'session-current': existingProgress },
      sessionTasks: [existingTask],
      todos: [existingTodo],
    });

    applyTaskProgressEvent(
      { type: 'agent_complete', data: null, sessionId: 'session-current' },
      deps,
    );
    applyTaskProgressEvent(
      { type: 'agent_cancelled', data: null, sessionId: 'session-current' },
      deps,
    );
    applyTaskProgressEvent(
      {
        type: 'error',
        data: { message: 'failed' },
        sessionId: 'session-current',
      },
      deps,
    );
    applyTaskProgressEvent(
      { type: 'stream_end', data: null, sessionId: 'session-current' },
      deps,
    );

    expect(state).toEqual({
      currentSessionId: 'session-current',
      lastEventAt: 41,
      sessionTaskComplete: { 'session-complete': existingComplete },
      sessionTaskProgress: { 'session-current': existingProgress },
      sessionTasks: [existingTask],
      todos: [existingTodo],
      unreadSessionIds: [],
    });
  });
});
