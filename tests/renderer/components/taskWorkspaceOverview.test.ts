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
  it('keeps invoked Skill, MCP, Memory and deduplicated files in one context projection', () => {
    const tools: ToolCapabilityView[] = [
      {
        id: 'tool:mcp__filesystem__read_file',
        label: 'mcp__filesystem__read_file',
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
        { id: 'tool:Skill:web', label: 'web-development', detail: 'Skill', bucket: 'rules', source: 'tool' },
        { id: 'file-1', bucket: 'files', source: 'tool', label: 'hello.html', path: '/tmp/hello.html', detail: 'Read' },
        { id: 'file-2', bucket: 'files', source: 'tool', label: 'hello.html', path: '/tmp/hello.html', detail: 'Write' },
      ],
      fallbacks: { unnamedOutput: '未命名输出', unknownCapability: '未知能力' },
    });

    expect(rows.map((row) => row.kind)).toEqual(['file', 'skill', 'mcp', 'memory']);
    expect(rows[0]).toMatchObject({
      label: 'hello.html',
      detail: 'Read / Write',
    });
    // MCP 按 server 去重显示 server 名
    expect(rows.find((row) => row.kind === 'mcp')).toMatchObject({ label: 'filesystem' });
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
      fallbacks: { unnamedOutput: '未命名输出', unknownCapability: '未知能力' },
    });

    expect(rows).toEqual([expect.objectContaining({
      kind: 'mcp',
      blocked: true,
      detail: 'Not connected',
    })]);
  });
});
