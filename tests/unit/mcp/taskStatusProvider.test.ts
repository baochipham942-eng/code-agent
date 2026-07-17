// ============================================================================
// TaskStatusProvider Tests（P3-A 只读任务状态聚合）
// ============================================================================
// 覆盖核心主权契约：
//   - 默认仅元数据：绝不外泄 prompt/产物/事件 message/文件路径/goal 指令文本
//   - includeContent opt-in 门：开启后才把内容字段加回
//   - listTasks 合并 swarm 运行历史 + 实时会话状态
//   - getRunDetail 事件 timeline 折叠成计数（byType/byLevel），不吐 title/summary
//   - swarmRepo 为 null 时安全降级
import { describe, it, expect } from 'vitest';
import {
  TaskStatusProvider,
  type ProjectServiceLike,
  type TaskManagerLike,
} from '../../../src/host/mcp/taskStatusProvider';
import type {
  SwarmTraceRepo,
  SwarmRunListItem,
  SwarmRunDetail,
} from '../../../src/shared/contract/swarmTrace';
import type { SessionState } from '../../../src/host/task/TaskManager';

// ---- fakes ----

function fakeRunListItem(id: string): SwarmRunListItem {
  return {
    id,
    sessionId: 'sess-1',
    status: 'completed',
    coordinator: 'hybrid',
    startedAt: 1000,
    endedAt: 5000,
    durationMs: 4000,
    totalAgents: 2,
    completedCount: 2,
    failedCount: 0,
    totalCostUsd: 0.01,
    totalTokensIn: 100,
    totalTokensOut: 200,
    trigger: 'llm-spawn',
  };
}

function fakeRunDetail(): SwarmRunDetail {
  return {
    run: {
      id: 'run-1',
      sessionId: 'sess-1',
      coordinator: 'hybrid',
      status: 'failed',
      startedAt: 1000,
      endedAt: 5000,
      totalAgents: 1,
      completedCount: 0,
      failedCount: 1,
      parallelPeak: 1,
      totalTokensIn: 100,
      totalTokensOut: 200,
      totalToolCalls: 3,
      totalCostUsd: 0.02,
      trigger: 'ui-launch',
      errorSummary: 'SECRET_ERROR_FREE_TEXT',
      aggregation: null,
      tags: ['t1'],
    },
    agents: [
      {
        runId: 'run-1',
        agentId: 'a1',
        name: 'Agent 1',
        role: 'researcher',
        status: 'failed',
        startTime: 1000,
        endTime: 5000,
        durationMs: 4000,
        tokensIn: 100,
        tokensOut: 200,
        toolCalls: 3,
        costUsd: 0.02,
        error: 'SECRET_AGENT_ERROR',
        failureCategory: 'timeout',
        filesChanged: ['/secret/path/a.ts', '/secret/path/b.ts'],
      },
    ],
    events: [
      {
        id: 1, runId: 'run-1', seq: 1, timestamp: 1100, eventType: 'agent_started',
        agentId: 'a1', level: 'info', title: 'SECRET_EVENT_TITLE', summary: 'SECRET_EVENT_SUMMARY', payload: { secret: true },
      },
      {
        id: 2, runId: 'run-1', seq: 2, timestamp: 1200, eventType: 'tool_call',
        agentId: 'a1', level: 'warn', title: 'T2', summary: 'S2', payload: null,
      },
      {
        id: 3, runId: 'run-1', seq: 3, timestamp: 1300, eventType: 'tool_call',
        agentId: 'a1', level: 'info', title: 'T3', summary: 'S3', payload: null,
      },
    ],
  };
}

function makeRepo(detail: SwarmRunDetail | null, runs: SwarmRunListItem[] = []): SwarmTraceRepo {
  return {
    startRun: () => {},
    closeRun: () => {},
    upsertAgent: () => {},
    appendEvent: () => {},
    listRuns: (limit: number) => runs.slice(0, limit),
    getRunDetail: () => detail,
    replaceRunCache: () => {},
    deleteRun: () => true,
    clearAll: () => {},
  };
}

const emptyProjectService: ProjectServiceLike = {
  listProjects: () => [],
  getProjectDetail: () => undefined,
};

function makeTaskManager(states: Record<string, SessionState>): TaskManagerLike {
  return { getAllStates: () => new Map(Object.entries(states)) };
}

const emptyTaskManager = makeTaskManager({});

// ---- tests ----

describe('TaskStatusProvider.getTaskStatus（隐私契约）', () => {
  it('默认仅元数据：不外泄事件文本/agent 错误文本/文件路径/run 错误摘要', () => {
    const provider = new TaskStatusProvider({
      getSwarmRepo: () => makeRepo(fakeRunDetail()),
      getProjectService: () => emptyProjectService,
      getTaskManager: () => emptyTaskManager,
    });

    const status = provider.getTaskStatus('run-1');
    expect(status).not.toBeNull();
    const json = JSON.stringify(status);

    // 关键：任何敏感自由文本/路径都不得出现在默认输出里
    expect(json).not.toContain('SECRET_ERROR_FREE_TEXT');
    expect(json).not.toContain('SECRET_AGENT_ERROR');
    expect(json).not.toContain('SECRET_EVENT_TITLE');
    expect(json).not.toContain('SECRET_EVENT_SUMMARY');
    expect(json).not.toContain('/secret/path');

    // 元数据/枚举/计数应保留
    expect(status!.status).toBe('failed');
    expect(status!.hasError).toBe(true);
    expect(status!.durationMs).toBe(4000);
    expect(status!.agents[0].failureCategory).toBe('timeout');
    expect(status!.agents[0].hasError).toBe(true);
    expect(status!.agents[0].filesChangedCount).toBe(2);
    // 事件 timeline 折叠成计数
    expect(status!.eventSummary.total).toBe(3);
    expect(status!.eventSummary.byType).toEqual({ agent_started: 1, tool_call: 2 });
    expect(status!.eventSummary.byLevel).toEqual({ info: 2, warn: 1 });
    expect(status!.eventSummary.lastTimestamp).toBe(1300);
    expect(status!.eventSummary.events).toBeUndefined();
  });

  it('includeContent opt-in 门：开启后才加回内容字段', () => {
    const provider = new TaskStatusProvider({
      getSwarmRepo: () => makeRepo(fakeRunDetail()),
      getProjectService: () => emptyProjectService,
      getTaskManager: () => emptyTaskManager,
    });

    const status = provider.getTaskStatus('run-1', { includeContent: true });
    const json = JSON.stringify(status);
    expect(json).toContain('SECRET_ERROR_FREE_TEXT');
    expect(json).toContain('SECRET_AGENT_ERROR');
    expect(json).toContain('SECRET_EVENT_TITLE');
    expect(json).toContain('/secret/path/a.ts');
    expect(status!.errorSummary).toBe('SECRET_ERROR_FREE_TEXT');
    expect(status!.agents[0].error).toBe('SECRET_AGENT_ERROR');
    expect(status!.agents[0].filesChanged).toEqual(['/secret/path/a.ts', '/secret/path/b.ts']);
    expect(status!.eventSummary.events).toHaveLength(3);
  });

  it('run 不存在返回 null；swarmRepo 为 null 也返回 null', () => {
    const p1 = new TaskStatusProvider({
      getSwarmRepo: () => makeRepo(null),
      getProjectService: () => emptyProjectService,
      getTaskManager: () => emptyTaskManager,
    });
    expect(p1.getTaskStatus('nope')).toBeNull();

    const p2 = new TaskStatusProvider({
      getSwarmRepo: () => null,
      getProjectService: () => emptyProjectService,
      getTaskManager: () => emptyTaskManager,
    });
    expect(p2.getTaskStatus('run-1')).toBeNull();
  });
});

describe('TaskStatusProvider.listTasks', () => {
  it('合并 swarm 运行历史 + 实时会话状态；会话 error 默认折叠成 hasError', () => {
    const provider = new TaskStatusProvider({
      getSwarmRepo: () => makeRepo(null, [fakeRunListItem('run-a'), fakeRunListItem('run-b')]),
      getProjectService: () => emptyProjectService,
      getTaskManager: () => makeTaskManager({
        's1': { status: 'running', startTime: 123 },
        's2': { status: 'error', error: 'SECRET_SESSION_ERROR' },
      }),
    });

    const result = provider.listTasks();
    expect(result.swarmRuns.map((r) => r.id)).toEqual(['run-a', 'run-b']);
    expect(result.liveSessions).toHaveLength(2);

    const s2 = result.liveSessions.find((s) => s.sessionId === 's2')!;
    expect(s2.status).toBe('error');
    expect(s2.hasError).toBe(true);
    expect(s2.error).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('SECRET_SESSION_ERROR');
  });

  it('swarmRepo 为 null 时 swarmRuns 安全降级为空', () => {
    const provider = new TaskStatusProvider({
      getSwarmRepo: () => null,
      getProjectService: () => emptyProjectService,
      getTaskManager: () => emptyTaskManager,
    });
    expect(provider.listTasks().swarmRuns).toEqual([]);
  });

  it('limit 透传给 repo.listRuns', () => {
    let received = -1;
    const provider = new TaskStatusProvider({
      getSwarmRepo: () => ({
        ...makeRepo(null),
        listRuns: (limit: number) => { received = limit; return []; },
      }),
      getProjectService: () => emptyProjectService,
      getTaskManager: () => emptyTaskManager,
    });
    provider.listTasks({ limit: 5 });
    expect(received).toBe(5);
  });
});

describe('TaskStatusProvider.listProjects（隐私契约）', () => {
  const baseProject = {
    id: 'p1', name: 'My Project', workspacePath: null, workspaceKey: null,
    status: 'active' as const, description: 'SECRET_PROJECT_DESCRIPTION',
    createdAt: 1, updatedAt: 2, archivedAt: null,
  };
  const projectService: ProjectServiceLike = {
    listProjects: () => [baseProject],
    getProjectDetail: () => ({
      project: baseProject,
      goals: [
        { id: 'g1', projectId: 'p1', goal: 'SECRET_GOAL_TEXT', verify: 'SECRET_VERIFY', review: 'SECRET_REVIEW', status: 'active', lastRunSessionId: null, createdAt: 1, updatedAt: 2 },
        { id: 'g2', projectId: 'p1', goal: 'g2text', verify: null, review: null, status: 'met', lastRunSessionId: 's9', createdAt: 1, updatedAt: 2 },
      ],
      roles: [{}, {}],
      sessionIds: ['s1', 's2', 's3'],
    }),
  };

  it('默认仅元数据：不外泄项目描述与 goal 指令文本，保留计数/状态分布', () => {
    const provider = new TaskStatusProvider({
      getSwarmRepo: () => null,
      getProjectService: () => projectService,
      getTaskManager: () => emptyTaskManager,
    });

    const projects = provider.listProjects();
    expect(projects).toHaveLength(1);
    const p = projects[0];
    const json = JSON.stringify(p);

    expect(json).not.toContain('SECRET_PROJECT_DESCRIPTION');
    expect(json).not.toContain('SECRET_GOAL_TEXT');
    expect(json).not.toContain('SECRET_VERIFY');
    expect(json).not.toContain('SECRET_REVIEW');

    expect(p.name).toBe('My Project'); // 名称作为协调身份标识保留
    expect(p.goalCount).toBe(2);
    expect(p.goalStatusCounts).toEqual({ active: 1, met: 1 });
    expect(p.roleCount).toBe(2);
    expect(p.sessionCount).toBe(3);
    expect(p.goals.map((g) => g.status)).toEqual(['active', 'met']);
    expect(p.goals[0].goal).toBeUndefined();
  });

  it('includeContent opt-in：加回描述与 goal 文本', () => {
    const provider = new TaskStatusProvider({
      getSwarmRepo: () => null,
      getProjectService: () => projectService,
      getTaskManager: () => emptyTaskManager,
    });
    const p = provider.listProjects({ includeContent: true })[0];
    expect(p.description).toBe('SECRET_PROJECT_DESCRIPTION');
    expect(p.goals[0].goal).toBe('SECRET_GOAL_TEXT');
    expect(p.goals[0].verify).toBe('SECRET_VERIFY');
  });
});
