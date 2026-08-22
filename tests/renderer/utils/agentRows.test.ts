// ============================================================================
// agentRows 单测（N-L6-AGENTVIEW）：九态→四态全表 + 三源合并去重
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { AgentTreeNode } from '../../../src/shared/contract/agentTree';
import type { LastToolStep, Task } from '../../../src/shared/contract/backgroundTask';
import { buildAgentRows, type MemberRowSource } from '../../../src/renderer/utils/agentRows';

const step: LastToolStep = { tool: 'Read', target: '/repo/a.ts', at: 1 };
const describeStep = (input: LastToolStep | undefined): string => (input ? `做了 ${input.tool}` : '正在整理任务…');

function member(overrides: Partial<MemberRowSource>): MemberRowSource {
  return {
    key: 'researcher', roleId: 'researcher', name: '调研员',
    status: 'running', isLead: false, ...overrides,
  };
}

function node(overrides: Partial<AgentTreeNode>): AgentTreeNode {
  return {
    id: 'agent-9', role: '审阅代理', status: 'running', statusLabel: '正在处理',
    children: [], worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [],
    sources: ['spawnGuard'], ...overrides,
  };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task-1', sessionId: 'session-1', source: 'delegate_task', title: '核对发布清单',
    status: 'running', createdAt: 1, updatedAt: 2, events: [], outputRefs: [], ...overrides,
  };
}

/** 九态→四态只在 agentRows 内部一处；对外只经 buildAgentRows 可见，所以全表走公共入口。 */
function rowStatusOf(status: string) {
  return buildAgentRows({
    members: [], tasks: [], describeStep: () => '',
    nodes: [node({ id: `n-${status}`, status: status as AgentTreeNode['status'] })],
  })[0]?.status;
}

describe('agentRowStatus 九态→四态全表（经 buildAgentRows）', () => {
  it.each([
    ['queued', 'working'],
    ['running', 'working'],
    ['running-recovered', 'working'],
    ['paused', 'working'],
    ['unknown', 'working'],
    ['waiting_input', 'waiting'],
    ['stalled', 'waiting'],
    ['blocked', 'waiting'],
    ['completed', 'done'],
    ['cancelled', 'done'],
    ['failed', 'failed'],
    ['killed', 'failed'],
    ['dead-log-only', 'failed'],
    ['expired', 'failed'],
    ['orphaned', 'failed'],
  ] as const)('%s → %s', (input, expected) => {
    expect(rowStatusOf(input)).toBe(expected);
  });

  it('表外状态宁可说在干（working），别说死', () => {
    expect(rowStatusOf('some-future-status')).toBe('working');
  });
});

describe('buildAgentRows 三源合并去重', () => {
  it('members 成 expert 行：状态映射、standby 不可停、running 可停', () => {
    const rows = buildAgentRows({
      members: [
        member({ key: 'lead', roleId: 'lead', name: '主理人', isLead: true, status: 'running' }),
        member({ key: 'extra-1', roleId: 'extra', name: '待命员', status: 'standby', standbyKey: 'extra' }),
      ],
      nodes: [],
      tasks: [],
      describeStep,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: 'lead', kind: 'expert', isLead: true, status: 'working', stoppable: true });
    expect(rows[1]).toMatchObject({ key: 'extra-1', kind: 'expert', status: 'standby', stoppable: false });
    // standby 行不带「当前一句」
    expect(rows[1].activity).toBeUndefined();
    // 非 standby 专家行没有真实工具步时回落空档句
    expect(rows[0].activity).toBe('正在整理任务…');
  });

  it('agentTree 节点与 member 同 key：不重复成行，lastToolStep/tokens 并回专家行', () => {
    const rows = buildAgentRows({
      members: [member({})],
      nodes: [node({ id: 'researcher', lastToolStep: step, budgetSummary: { tokensUsed: 1200 } })],
      tasks: [],
      describeStep,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'researcher', kind: 'expert', activity: '做了 Read', tokens: 1200,
    });
    expect(rows[0].node?.id).toBe('researcher');
  });

  it('普通节点成 kind agent 行，状态走九态表', () => {
    const rows = buildAgentRows({
      members: [],
      nodes: [node({ id: 'agent-9', status: 'blocked', lastToolStep: step })],
      tasks: [],
      describeStep,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'agent-9', kind: 'agent', name: '审阅代理', status: 'waiting', stoppable: false,
      activity: '做了 Read',
    });
  });

  it('同一代理在 agentTree 与 Task 都有：只有一行，Task 挂到节点行上', () => {
    const shared = task({ id: 'agent-9', summary: '清单已核对' });
    const rows = buildAgentRows({
      members: [],
      nodes: [node({ id: 'agent-9' })],
      tasks: [shared],
      describeStep,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('agent');
    expect(rows[0].task?.id).toBe('agent-9');
  });

  it.each([
    ['按 task.runId 匹配', { runId: 'agent-9' } as Partial<Task>],
    ['按 metadata.childRunId 匹配', { metadata: { childRunId: 'agent-9' } } as Partial<Task>],
  ])('Task 与节点%s时也并到节点行', (_label, overrides) => {
    const rows = buildAgentRows({
      members: [],
      nodes: [node({ id: 'agent-9' })],
      tasks: [task({ id: 'task-1', ...overrides })],
      describeStep,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('agent-9');
    expect(rows[0].task?.id).toBe('task-1');
  });

  it('Task 匹配不到任何节点时自成 kind task 行', () => {
    const rows = buildAgentRows({
      members: [],
      nodes: [node({ id: 'agent-9' })],
      tasks: [task({ id: 'task-1', status: 'completed', failure: undefined })],
      describeStep,
    });

    expect(rows).toHaveLength(2);
    const taskRow = rows.find((row) => row.kind === 'task');
    expect(taskRow).toMatchObject({ key: 'task-1', name: '核对发布清单', status: 'done' });
  });

  it('失败 Task 行带 failureReason，running Task 行可停', () => {
    const rows = buildAgentRows({
      members: [],
      nodes: [],
      tasks: [
        task({ id: 'task-failed', status: 'failed', failure: { message: '炸了' } as Task['failure'] }),
        task({ id: 'task-running', status: 'running' }),
      ],
      describeStep,
    });

    const failed = rows.find((row) => row.key === 'task-failed');
    expect(failed).toMatchObject({ status: 'failed', failureReason: '炸了', stoppable: false });
    const running = rows.find((row) => row.key === 'task-running');
    expect(running).toMatchObject({ status: 'working', stoppable: true });
  });
});
