import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MemoryActivitySummary, RunOverview } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';
import type { RunWorkbenchModel } from '../../../src/renderer/types/runWorkbench';

describe('MemoryActivitySummary', () => {
  it('renders memory activity rows as detail buttons when navigation is available', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryActivitySummary, {
        activities: [
          {
            runId: 'turn-1',
            action: 'updated',
            memoryId: 'ui_memory_activity_smoke.md',
            filename: 'ui_memory_activity_smoke.md',
            title: 'UI Memory Activity Smoke',
            reason: '更新记忆: ui_memory_activity_smoke.md',
            targetPath: '/Users/linchen/.code-agent/memory/ui_memory_activity_smoke.md',
          },
        ],
        onOpenActivity: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="memory-activity-row"');
    expect(html).toContain('<button');
    expect(html).toContain('UI Memory Activity Smoke');
    expect(html).toContain('ui_memory_activity_smoke.md');
  });
});

describe('RunOverview memory link', () => {
  it('renders a lightweight memory action when a memory handler is provided', () => {
    const model: RunWorkbenchModel = {
      run: {
        identity: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          runId: 'run-1',
          streamRunId: 'stream-1',
          status: 'completed',
        },
        status: 'completed',
        phase: '已完成',
        activeToolName: 'MemoryWrite',
      },
      loopDecisions: [],
      tools: [],
      tasks: [],
      subagents: [],
      outputs: [],
      memoryActivities: [
        {
          runId: 'run-1',
          action: 'created',
          memoryId: 'ui_memory_activity_smoke.md',
          filename: 'ui_memory_activity_smoke.md',
          title: 'UI Memory Activity Smoke',
          reason: '创建记忆',
        },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(RunOverview, {
        model,
        onOpenMemory: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="run-overview-memory-link"');
    expect(html).toContain('<button');
    expect(html).toContain('Memory activity 1');
    expect(html).not.toContain('Tasks');
    expect(html).not.toContain('Outputs');
    expect(html).not.toContain('border-emerald-500');
  });
});
