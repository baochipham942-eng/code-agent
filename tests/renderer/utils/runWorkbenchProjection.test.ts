import { describe, expect, it } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import {
  buildLoopDecisionViews,
  buildMemoryActivityEvents,
  buildOutputArtifactViews,
  buildRunUiState,
  buildSessionTaskRecord,
  buildToolCapabilityViews,
} from '../../../src/renderer/utils/runWorkbenchProjection';

const projection: TraceProjection = {
  sessionId: 'session-1',
  activeTurnIndex: 0,
  turns: [
    {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'streaming',
      startTime: 100,
      nodes: [
        {
          id: 'user-1',
          type: 'user',
          content: '帮我继续这个任务',
          timestamp: 100,
        },
        {
          id: 'timeline-scope',
          type: 'turn_timeline',
          content: '',
          timestamp: 110,
          turnTimeline: {
            id: 'timeline-scope',
            kind: 'capability_scope',
            timestamp: 110,
            tone: 'warning',
            capabilityScope: {
              mode: 'manual',
              selected: [{ kind: 'skill', id: 'memory-management', label: 'memory-management' }],
              allowed: [],
              invoked: [],
              blocked: [{
                kind: 'skill',
                id: 'memory-management',
                label: 'memory-management',
                code: 'skill_not_mounted',
                detail: 'Skill not mounted for this turn',
                hint: 'Mount it from Skills',
                severity: 'warning',
              }],
            },
          },
        },
        {
          id: 'tool-memory',
          type: 'tool_call',
          content: '',
          timestamp: 120,
          toolCall: {
            id: 'tool-memory',
            name: 'memory_search',
            args: { query: 'Alma UI plan' },
            result: 'found 2 memories',
            success: true,
          },
        },
        {
          id: 'tool-write',
          type: 'tool_call',
          content: '',
          timestamp: 130,
          toolCall: {
            id: 'tool-write',
            name: 'Write',
            args: { path: 'docs/plan.md' },
            result: 'ok',
            success: true,
            outputPath: '/repo/docs/plan.md',
          },
        },
        {
          id: 'timeline-artifact',
          type: 'turn_timeline',
          content: '',
          timestamp: 140,
          turnTimeline: {
            id: 'timeline-artifact',
            kind: 'artifact_ownership',
            timestamp: 140,
            tone: 'success',
            artifactOwnership: [{
              kind: 'file',
              label: 'plan.md',
              ownerKind: 'tool',
              ownerLabel: 'Write',
              path: '/repo/docs/plan.md',
            }],
          },
        },
      ],
    },
  ],
};

describe('runWorkbenchProjection', () => {
  it('derives blocked run state from current turn capability warnings', () => {
    const run = buildRunUiState({
      projection,
      sessionId: 'session-1',
      sessionStatus: 'running',
    });

    expect(run.status).toBe('running');
    expect(run.blockedReason).toBe('Skill not mounted for this turn');
    expect(run.completionSignal).toBe('1 个产物');
  });

  it('keeps cancelled run state after the runtime returns to idle', () => {
    const cancelledProjection: TraceProjection = {
      sessionId: 'session-cancel',
      activeTurnIndex: -1,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-cancelled',
          status: 'completed',
          startTime: 100,
          nodes: [
            {
              id: 'user-cancel',
              type: 'user',
              content: 'stop this run',
              timestamp: 100,
              metadata: {
                workbench: {
                  runCancellation: {
                    status: 'cancelled',
                    cancelledAt: 200,
                  },
                },
              },
            },
          ],
        },
      ],
    };

    expect(buildRunUiState({
      projection: cancelledProjection,
      sessionId: 'session-cancel',
      sessionStatus: 'idle',
    }).status).toBe('cancelled');
  });

  it('builds timeline, tools, memory, and outputs from the latest turn', () => {
    expect(buildLoopDecisionViews(projection).map((item) => item.action)).toEqual([
      '能力范围',
      '产物归属',
      '工具完成',
      '工具完成',
    ]);
    expect(buildToolCapabilityViews(projection)).toMatchObject([
      { id: 'memory-management', source: 'skill', callable: false },
      { label: 'memory_search', source: 'memory', callable: true },
      { label: 'Write', source: 'builtin', callable: true },
    ]);
    expect(buildMemoryActivityEvents(projection)).toMatchObject([
      { action: 'used', title: 'Alma UI plan' },
    ]);
    expect(buildOutputArtifactViews(projection)).toMatchObject([
      { title: 'plan.md', pathOrUrl: '/repo/docs/plan.md', previewState: 'available' },
    ]);
  });

  it('does not count read-only tool metadata as output artifacts', () => {
    const readProjection: TraceProjection = {
      sessionId: 'session-read',
      activeTurnIndex: 0,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-read',
          status: 'completed',
          startTime: 100,
          nodes: [
            {
              id: 'timeline-read',
              type: 'turn_timeline',
              content: '',
              timestamp: 110,
              turnTimeline: {
                id: 'timeline-read',
                kind: 'artifact_ownership',
                timestamp: 110,
                tone: 'success',
                artifactOwnership: [
                  {
                    kind: 'file',
                    label: 'configParser.ts',
                    ownerKind: 'tool',
                    ownerLabel: 'Read',
                    path: '/repo/src/configParser.ts',
                  },
                ],
              },
            },
            {
              id: 'tool-read',
              type: 'tool_call',
              content: '',
              timestamp: 120,
              toolCall: {
                id: 'tool-read',
                name: 'Read file',
                args: { path: '/repo/src/configParser.ts' },
                result: 'file content',
                success: true,
                outputPath: '/repo/src/configParser.ts',
                metadata: {
                  filePath: '/repo/src/configParser.ts',
                },
              },
            },
          ],
        },
      ],
    };

    expect(buildOutputArtifactViews(readProjection)).toEqual([]);
  });

  it('classifies memory read, create, update, and delete events from tool metadata', () => {
    const memoryProjection: TraceProjection = {
      sessionId: 'session-2',
      activeTurnIndex: 0,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-memory',
          status: 'completed',
          startTime: 200,
          nodes: [
            {
              id: 'memory-read',
              type: 'tool_call',
              content: '',
              timestamp: 210,
              toolCall: {
                id: 'memory-read',
                name: 'MemoryRead',
                args: { filename: 'project.md' },
                result: 'project context',
                success: true,
                metadata: { filename: 'project.md', path: '/mem/project.md' },
              },
            },
            {
              id: 'memory-create',
              type: 'tool_call',
              content: '',
              timestamp: 220,
              toolCall: {
                id: 'memory-create',
                name: 'MemoryWrite',
                args: {
                  action: 'write',
                  filename: 'new.md',
                  name: 'New memory',
                  description: 'new preference',
                },
                result: 'saved',
                success: true,
                metadata: {
                  action: 'write',
                  filename: 'new.md',
                  path: '/mem/new.md',
                  existed: false,
                },
              },
            },
            {
              id: 'memory-update',
              type: 'tool_call',
              content: '',
              timestamp: 230,
              toolCall: {
                id: 'memory-update',
                name: 'MemoryWrite',
                args: {
                  action: 'write',
                  filename: 'existing.md',
                  name: 'Existing memory',
                },
                result: 'saved',
                success: true,
                metadata: {
                  action: 'write',
                  filename: 'existing.md',
                  path: '/mem/existing.md',
                  existed: true,
                },
              },
            },
            {
              id: 'memory-delete',
              type: 'tool_call',
              content: '',
              timestamp: 240,
              toolCall: {
                id: 'memory-delete',
                name: 'MemoryWrite',
                args: {
                  action: 'delete',
                  filename: 'old.md',
                },
                result: 'deleted',
                success: true,
                metadata: {
                  action: 'delete',
                  filename: 'old.md',
                  path: '/mem/old.md',
                  existed: true,
                },
              },
            },
          ],
        },
      ],
    };

    expect(buildMemoryActivityEvents(memoryProjection)).toMatchObject([
      {
        action: 'used',
        memoryId: 'project.md',
        filename: 'project.md',
        title: 'project.md',
        reason: '读取记忆: project.md',
        targetPath: '/mem/project.md',
      },
      {
        action: 'created',
        memoryId: 'new.md',
        filename: 'new.md',
        title: 'New memory',
        reason: '写入记忆: new.md',
        targetPath: '/mem/new.md',
      },
      {
        action: 'updated',
        memoryId: 'existing.md',
        filename: 'existing.md',
        title: 'Existing memory',
        reason: '更新记忆: existing.md',
        targetPath: '/mem/existing.md',
      },
      {
        action: 'deleted',
        memoryId: 'old.md',
        filename: 'old.md',
        title: 'old.md',
        reason: '删除记忆: old.md',
        targetPath: '/mem/old.md',
      },
    ]);
  });

  it('builds a session task record from todos', () => {
    const task = buildSessionTaskRecord({
      sessionId: 'session-1',
      runId: 'turn-1',
      runStatus: 'running',
      todos: [
        { content: '梳理任务面板现状', status: 'completed' },
        { content: '改造任务面板展示', activeForm: '改造任务面板展示', status: 'in_progress' },
      ],
    });

    expect(task).toMatchObject({
      scope: 'session',
      title: '改造任务面板展示',
      status: 'in_progress',
      ownerRunId: 'turn-1',
    });
    expect(task?.steps.map((step) => step.status)).toEqual(['completed', 'in_progress']);
  });

  it('uses an explicit task objective as the stable title', () => {
    const task = buildSessionTaskRecord({
      sessionId: 'session-1',
      runId: 'turn-1',
      runStatus: 'running',
      todos: [
        { content: '任务目标：验证任务面板复杂任务展示', status: 'completed' },
        { content: '检查多个子任务', activeForm: '检查多个子任务', status: 'in_progress' },
        { content: '验证完成态', status: 'pending' },
      ],
    });

    expect(task).toMatchObject({
      title: '任务目标：验证任务面板复杂任务展示',
      status: 'in_progress',
    });
  });

  it('keeps completed session todos visible after a completed run', () => {
    const task = buildSessionTaskRecord({
      sessionId: 'session-1',
      runId: 'turn-1',
      runStatus: 'completed',
      todos: [
        { content: '任务目标：验证任务面板复杂任务展示', status: 'completed' },
        { content: '检查多个子任务', status: 'completed' },
        { content: '验证完成态', status: 'completed' },
      ],
    });

    expect(task).toMatchObject({
      scope: 'session',
      title: '任务目标：验证任务面板复杂任务展示',
      status: 'completed',
    });
    expect(task?.steps.map((step) => step.status)).toEqual(['completed', 'completed', 'completed']);
  });

  it('builds a session task record from canonical SessionTask data with dependencies', () => {
    const task = buildSessionTaskRecord({
      sessionId: 'session-1',
      runId: 'turn-1',
      runStatus: 'running',
      sessionTasks: [
        {
          id: 'task-a',
          subject: '梳理任务面板现状',
          description: '确认当前任务面板的数据来源和展示状态',
          activeForm: '梳理任务面板现状',
          status: 'pending',
          priority: 'normal',
          blocks: ['task-b'],
          blockedBy: [],
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'task-b',
          subject: '渲染依赖状态',
          description: '把 SessionTask 依赖关系展示到任务面板',
          activeForm: '渲染依赖状态',
          status: 'pending',
          priority: 'normal',
          blocks: [],
          blockedBy: ['task-a'],
          metadata: {},
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });

    expect(task).toMatchObject({
      id: 'session-1:session-tasks',
      scope: 'session',
      title: '梳理任务面板现状',
      status: 'pending',
      steps: [
        { title: '梳理任务面板现状', status: 'pending', blockedTaskTitles: ['渲染依赖状态'] },
        { title: '渲染依赖状态', status: 'blocked', blockedByTitles: ['梳理任务面板现状'] },
      ],
    });
  });

  it('does not let blocked downstream dependencies mask the actionable SessionTask status', () => {
    const task = buildSessionTaskRecord({
      sessionId: 'session-1',
      runId: 'turn-1',
      runStatus: 'running',
      sessionTasks: [
        {
          id: 'task-a',
          subject: '修复任务面板状态聚合',
          description: '让可执行任务状态优先于被阻塞的下游任务',
          activeForm: '修复任务面板状态聚合',
          status: 'in_progress',
          priority: 'normal',
          blocks: ['task-b'],
          blockedBy: [],
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'task-b',
          subject: '验证依赖展示',
          description: '确认下游依赖以 blocked 状态展示',
          activeForm: '验证依赖展示',
          status: 'pending',
          priority: 'normal',
          blocks: [],
          blockedBy: ['task-a'],
          metadata: {},
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });

    expect(task).toMatchObject({
      title: '修复任务面板状态聚合',
      status: 'in_progress',
      steps: [
        { title: '修复任务面板状态聚合', status: 'in_progress', blockedTaskTitles: ['验证依赖展示'] },
        { title: '验证依赖展示', status: 'blocked', blockedByTitles: ['修复任务面板状态聚合'] },
      ],
    });
  });

  it('only reports the aggregate SessionTask status as blocked when no pending task is actionable', () => {
    const task = buildSessionTaskRecord({
      sessionId: 'session-1',
      runId: 'turn-1',
      runStatus: 'running',
      sessionTasks: [
        {
          id: 'task-a',
          subject: 'Wait for source',
          description: 'Wait for source',
          activeForm: 'Wait for source',
          status: 'pending',
          priority: 'normal',
          blocks: [],
          blockedBy: ['missing-source'],
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    expect(task).toMatchObject({
      title: 'Wait for source',
      status: 'blocked',
      steps: [
        { title: 'Wait for source', status: 'blocked', blockedByTitles: ['missing-source'] },
      ],
    });
  });

  it('derives blocked tasks from blocks-only SessionTask dependencies', () => {
    const task = buildSessionTaskRecord({
      sessionId: 'session-1',
      runId: 'turn-1',
      runStatus: 'running',
      sessionTasks: [
        {
          id: 'task-a',
          subject: 'Prepare source data',
          description: 'Prepare source data',
          activeForm: 'Preparing source data',
          status: 'pending',
          priority: 'normal',
          blocks: ['task-b'],
          blockedBy: [],
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'task-b',
          subject: 'Render dependency state',
          description: 'Render dependency state',
          activeForm: 'Rendering dependency state',
          status: 'pending',
          priority: 'normal',
          blocks: [],
          blockedBy: [],
          metadata: {},
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });

    expect(task?.steps).toEqual([
      expect.objectContaining({
        title: 'Prepare source data',
        status: 'pending',
        blockedTaskTitles: ['Render dependency state'],
      }),
      expect.objectContaining({
        title: 'Render dependency state',
        status: 'blocked',
        blockedByTitles: ['Prepare source data'],
      }),
    ]);
  });

  it('suppresses incomplete stored session todos after a completed run', () => {
    const task = buildSessionTaskRecord({
      sessionId: 'session-1',
      runId: 'turn-1',
      runStatus: 'completed',
      todos: [
        { content: 'Stale task', activeForm: 'Reviewing API documentation', status: 'in_progress' },
      ],
    });

    expect(task).toBeNull();
  });

  it('keeps live task progress visible while a run is active', () => {
    const task = buildSessionTaskRecord({
      sessionId: 'session-1',
      runId: 'turn-1',
      runStatus: 'using_tools',
      taskProgress: {
        phase: 'tool_running',
        tool: 'MemoryWrite',
        step: 'Writing memory',
      },
    });

    expect(task).toMatchObject({
      title: 'Writing memory',
      status: 'in_progress',
    });
  });
});
