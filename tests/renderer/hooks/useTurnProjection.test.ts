import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { SwarmLaunchRequest } from '../../../src/shared/contract/swarm';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

describe('projectTurns', () => {
  it('projects the latest pending launch request into the last turn', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '帮我并行分析这个仓库',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '我先拆一下任务。',
        timestamp: 150,
      },
    ];

    const launchRequests: SwarmLaunchRequest[] = [
      {
        id: 'launch-old',
        sessionId: 'session-1',
        status: 'approved',
        requestedAt: 170,
        resolvedAt: 171,
        summary: '旧请求',
        agentCount: 2,
        dependencyCount: 1,
        writeAgentCount: 1,
        tasks: [],
      },
      {
        id: 'launch-pending',
        sessionId: 'session-1',
        status: 'pending',
        requestedAt: 200,
        summary: '准备启动 3 个 agent',
        agentCount: 3,
        dependencyCount: 2,
        writeAgentCount: 1,
        tasks: [],
      },
    ];

    const projection = projectTurns(messages, 'session-1', false, launchRequests);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].nodes.map((node) => node.type)).toEqual([
      'user',
      'assistant_text',
      'swarm_launch_request',
    ]);
    expect(projection.turns[0].nodes[2]?.launchRequest?.id).toBe('launch-pending');
  });

  it('creates a standalone turn when only a pending launch request exists', () => {
    const launchRequests: SwarmLaunchRequest[] = [
      {
        id: 'launch-only',
        sessionId: 'session-2',
        status: 'pending',
        requestedAt: 500,
        summary: '等待启动审批',
        agentCount: 2,
        dependencyCount: 0,
        writeAgentCount: 0,
        tasks: [],
      },
    ];

    const projection = projectTurns([], 'session-2', false, launchRequests);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].startTime).toBe(500);
    expect(projection.turns[0].nodes).toHaveLength(1);
    expect(projection.turns[0].nodes[0]?.type).toBe('swarm_launch_request');
  });

  it('does not project resolved launch requests into chat trace', () => {
    const launchRequests: SwarmLaunchRequest[] = [
      {
        id: 'launch-approved',
        sessionId: 'session-3',
        status: 'approved',
        requestedAt: 300,
        resolvedAt: 320,
        summary: '已批准',
        agentCount: 1,
        dependencyCount: 0,
        writeAgentCount: 0,
        tasks: [],
      },
    ];

    const projection = projectTurns([], 'session-3', false, launchRequests);

    expect(projection.turns).toHaveLength(0);
    expect(projection.activeTurnIndex).toBe(-1);
  });

  it('keeps the previous assistant turn active when a direct-routed user message is appended', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '继续执行刚才的并行任务',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '正在执行中',
        timestamp: 150,
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'reviewer 先看测试风险',
        timestamp: 220,
        metadata: {
          workbench: {
            routingMode: 'direct',
            targetAgentIds: ['agent-reviewer'],
            directRoutingDelivery: {
              deliveredTargetIds: ['agent-reviewer'],
              deliveredTargetNames: ['Reviewer'],
            },
          },
        },
      },
    ];

    const projection = projectTurns(messages, 'session-4', true, []);

    expect(projection.turns).toHaveLength(2);
    expect(projection.activeTurnIndex).toBe(0);
    expect(projection.turns[0].status).toBe('streaming');
    expect(projection.turns[1].status).toBe('completed');
  });

  it('attaches a runtime supplement to the current active turn', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '先分析这个问题',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '正在分析中',
        timestamp: 150,
      },
      {
        id: 'user-2',
        role: 'user',
        content: '补充一下，客户读者也要覆盖',
        timestamp: 220,
        metadata: {
          workbench: {
            runtimeInputMode: 'supplement',
          },
        },
      },
    ];

    const projection = projectTurns(messages, 'session-4', true, []);

    expect(projection.turns).toHaveLength(1);
    expect(projection.activeTurnIndex).toBe(0);
    expect(projection.turns[0].status).toBe('streaming');
    expect(projection.turns[0].nodes.map((node) => node.id)).toEqual([
      'user-1',
      'assistant-1-text',
      'user-2',
    ]);
  });

  it('marks a newly submitted normal user turn active while waiting for the assistant response', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '上一轮问题',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '上一轮回答',
        timestamp: 150,
      },
      {
        id: 'user-2',
        role: 'user',
        content: '继续',
        timestamp: 220,
      },
    ];

    const projection = projectTurns(messages, 'session-4', true, []);

    expect(projection.turns).toHaveLength(2);
    expect(projection.activeTurnIndex).toBe(1);
    expect(projection.turns[0].status).toBe('completed');
    expect(projection.turns[1].status).toBe('streaming');
    expect(projection.turns[1].startTime).toBe(220);
  });

  it('ignores pending launch requests from another session', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '继续当前会话',
        timestamp: 100,
      },
    ];

    const launchRequests: SwarmLaunchRequest[] = [
      {
        id: 'launch-other-session',
        sessionId: 'session-2',
        status: 'pending',
        requestedAt: 120,
        summary: '别的会话的并行启动',
        agentCount: 2,
        dependencyCount: 1,
        writeAgentCount: 1,
        tasks: [],
      },
    ];

    const projection = projectTurns(messages, 'session-1', false, launchRequests);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].nodes.map((node) => node.type)).toEqual(['user']);
  });

  it('preserves structured tool artifact metadata on tool call nodes', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '读取报告',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 130,
        toolCalls: [
          {
            id: 'call-read-1',
            name: 'Read',
            arguments: {
              path: '/repo/app/report.md',
            },
            result: {
              toolCallId: 'call-read-1',
              success: true,
              output: '# Report',
              metadata: {
                artifact: {
                  artifactId: 'artifact-read-report',
                  kind: 'text',
                  sourceTool: 'Read',
                  createdAt: '2026-05-07T00:00:00.000Z',
                  name: 'report.md',
                  path: '/repo/app/report.md',
                  mimeType: 'text/markdown',
                  preview: '# Report',
                },
              },
            },
          },
        ],
      },
    ];

    const projection = projectTurns(messages, 'session-artifact', false, []);
    const toolNode = projection.turns[0]?.nodes.find((node) => node.type === 'tool_call');

    expect(toolNode?.toolCall?.metadata?.artifact).toMatchObject({
      artifactId: 'artifact-read-report',
      kind: 'text',
      sourceTool: 'Read',
      name: 'report.md',
      path: '/repo/app/report.md',
    });
  });
});
