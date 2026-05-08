import { describe, expect, it } from 'vitest';
import type { MemoryActivityEvent } from '../../../src/renderer/types/runWorkbench';
import { getMemoryActivityFocus } from '../../../src/renderer/utils/memoryActivityNavigation';

function activity(overrides: Partial<MemoryActivityEvent>): MemoryActivityEvent {
  return {
    runId: 'turn-1',
    action: 'updated',
    memoryId: 'memory-1',
    title: 'Project preference',
    reason: '更新记忆',
    ...overrides,
  };
}

describe('memoryActivityNavigation', () => {
  it('prefers the exact memory filename when the activity has one', () => {
    expect(getMemoryActivityFocus(activity({
      filename: 'project.md',
      targetPath: '/Users/linchen/.code-agent/memory/project.md',
    }))).toEqual({
      filename: 'project.md',
      query: 'project.md',
    });
  });

  it('derives a filename from path-like ids before falling back to title search', () => {
    expect(getMemoryActivityFocus(activity({
      memoryId: '/Users/linchen/.code-agent/memory/feedback.md',
      targetPath: '/Users/linchen/.code-agent/memory/ignored.md',
    }))).toEqual({
      filename: 'feedback.md',
      query: 'feedback.md',
    });
  });

  it('uses the activity title when no concrete memory file can be inferred', () => {
    expect(getMemoryActivityFocus(activity({
      memoryId: 'search:Alma UI plan',
      title: 'Alma UI plan',
    }))).toEqual({
      filename: undefined,
      query: 'Alma UI plan',
    });
  });
});
