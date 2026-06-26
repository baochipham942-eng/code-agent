// ============================================================================
// taskCreate 工具 — 树状/owner 语义（roadmap 2.6）
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  db: {
    isReady: true,
    saveSessionTasks: vi.fn(),
    getSessionTasks: vi.fn(() => []),
    appendSessionTaskEvents: vi.fn(),
  },
}));

vi.mock('../../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

vi.mock('../../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'tool-tree-session',
    workingDir: '/tmp',
    abortSignal: { aborted: false } as AbortSignal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: vi.fn(),
    ...overrides,
  } as never;
}

const canUseTool = vi.fn(async () => ({ allow: true }));

describe('taskCreate — tree/owner semantics', () => {
  beforeEach(() => {
    vi.resetModules();
    canUseTool.mockClear();
    dbState.db.getSessionTasks.mockReturnValue([]);
  });

  it('defaults owner to the creating subagent', async () => {
    const { executeTaskCreate } = await import('../../../../../src/host/tools/modules/planning/taskCreate');
    const result = await executeTaskCreate(
      { subject: 'Sub work', description: 'd' },
      makeCtx({ agentId: 'subagent_123_xyz' }),
      canUseTool
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const task = (result.meta as { task: { owner?: string } }).task;
      expect(task.owner).toBe('subagent_123_xyz');
    }
  });

  it('does not assign owner for main-loop creations', async () => {
    const { executeTaskCreate } = await import('../../../../../src/host/tools/modules/planning/taskCreate');
    const result = await executeTaskCreate(
      { subject: 'Main work', description: 'd' },
      makeCtx(),
      canUseTool
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.meta as { task: { owner?: string } }).task.owner).toBeUndefined();
    }
  });

  it('creates hierarchical children and rejects unknown parents', async () => {
    const { executeTaskCreate } = await import('../../../../../src/host/tools/modules/planning/taskCreate');
    const ctx = makeCtx();
    const parent = await executeTaskCreate({ subject: 'P', description: 'p' }, ctx, canUseTool);
    expect(parent.ok).toBe(true);

    const child = await executeTaskCreate(
      { subject: 'C', description: 'c', parentTaskId: '1' },
      ctx,
      canUseTool
    );
    expect(child.ok).toBe(true);
    if (child.ok) {
      expect((child.meta as { taskId: string }).taskId).toBe('1.1');
    }

    const orphan = await executeTaskCreate(
      { subject: 'X', description: 'x', parentTaskId: '404' },
      ctx,
      canUseTool
    );
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) {
      expect(orphan.code).toBe('INVALID_ARGS');
      expect(orphan.error).toMatch(/parent/i);
    }
  });
});
