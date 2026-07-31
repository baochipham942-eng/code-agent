import { describe, expect, it } from 'vitest';
import {
  buildOverviewContextRows,
  summarizeTodoProgress,
} from '../../../src/renderer/components/TaskPanel/TaskWorkspaceOverview';
import type {
  MemoryActivityEvent,
  TaskRecord,
  ToolCapabilityView,
} from '../../../src/renderer/types/runWorkbench';

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'session:todos',
    scope: 'session',
    title: 'Implement overview',
    status: 'in_progress',
    steps: [
      { title: 'Keep completed work', status: 'completed' },
      { title: 'Render current work', status: 'in_progress' },
      { title: 'Ignore abandoned work', status: 'cancelled' },
    ],
    ...overrides,
  };
}

describe('summarizeTodoProgress', () => {
  it('uses the current-session task and excludes cancelled work from the denominator', () => {
    const background = task({
      id: 'background',
      scope: 'global',
      steps: [{ title: 'Background task', status: 'pending' }],
    });

    expect(summarizeTodoProgress([background, task()])).toEqual({
      completed: 1,
      total: 2,
      label: '1/2',
    });
  });

  it('keeps a completed todo visible as completed instead of regressing it', () => {
    expect(summarizeTodoProgress([
      task({
        status: 'completed',
        steps: [
          { title: 'Created file', status: 'completed' },
          { title: 'Verified result', status: 'completed' },
        ],
      }),
    ])).toEqual({
      completed: 2,
      total: 2,
      label: '2/2',
    });
  });

  it('returns no misleading progress label when there are no real todo steps', () => {
    expect(summarizeTodoProgress([])).toEqual({
      completed: 0,
      total: 0,
      label: undefined,
    });
  });
});

describe('buildOverviewContextRows', () => {
  it('keeps Skill, MCP, Memory and deduplicated files in one context projection', () => {
    const tools: ToolCapabilityView[] = [
      {
        id: 'skill:web',
        label: 'web-development',
        source: 'skill',
        callable: true,
        activatedForTurn: true,
      },
      {
        id: 'mcp:filesystem',
        label: 'filesystem',
        source: 'mcp',
        callable: true,
        activatedForTurn: true,
      },
      {
        id: 'builtin:bash',
        label: 'Bash',
        source: 'builtin',
        callable: true,
        activatedForTurn: true,
      },
    ];
    const memoryActivities: MemoryActivityEvent[] = [{
      runId: 'run-1',
      action: 'used',
      memoryId: 'memory-1',
      filename: 'MEMORY.md',
      title: 'Project memory',
      reason: 'Read project context',
    }];

    const rows = buildOverviewContextRows({
      tools,
      memoryActivities,
      contextItems: [
        { id: 'file-1', bucket: 'files', label: 'hello.html', path: '/tmp/hello.html', detail: 'Read' },
        { id: 'file-2', bucket: 'files', label: 'hello.html', path: '/tmp/hello.html', detail: 'Write' },
      ],
    });

    expect(rows.map((row) => row.kind)).toEqual(['skill', 'mcp', 'memory', 'file']);
    expect(rows.at(-1)).toMatchObject({
      label: 'hello.html',
      detail: 'Read / Write',
    });
  });

  it('surfaces blocked context without turning it into an approval card', () => {
    const rows = buildOverviewContextRows({
      tools: [{
        id: 'mcp:offline',
        label: 'offline-server',
        source: 'mcp',
        callable: false,
        blockedReason: 'Not connected',
        activatedForTurn: true,
      }],
      memoryActivities: [],
      contextItems: [],
    });

    expect(rows).toEqual([expect.objectContaining({
      kind: 'mcp',
      blocked: true,
      detail: 'Not connected',
    })]);
  });
});
