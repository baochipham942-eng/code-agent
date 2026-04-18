import { describe, expect, it } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import { buildTurnExecutionClarityProjection } from '../../../src/renderer/utils/turnTimelineProjection';

describe('buildTurnExecutionClarityProjection', () => {
  it('injects snapshot, capability scope, routing evidence, and artifact ownership nodes into a direct turn', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: -1,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'completed',
          startTime: 100,
          endTime: 160,
          nodes: [
            {
              id: 'user-1',
              type: 'user',
              content: '把这个任务交给 reviewer',
              timestamp: 100,
              metadata: {
                workbench: {
                  workingDirectory: '/repo/app',
                  routingMode: 'direct',
                  targetAgentIds: ['agent-reviewer'],
                  targetAgentNames: ['reviewer'],
                  executionIntent: {
                    browserSessionMode: 'managed',
                    preferBrowserSession: true,
                    allowBrowserAutomation: true,
                    browserSessionSnapshot: {
                      ready: true,
                      preview: {
                        title: 'Docs · Example',
                        url: 'https://example.com/docs',
                      },
                    },
                  },
                  selectedSkillIds: ['draft-skill'],
                  selectedConnectorIds: ['mail'],
                  selectedMcpServerIds: ['github'],
                },
              },
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '已生成执行图表',
              timestamp: 130,
              artifacts: [
                {
                  id: 'artifact-1',
                  type: 'chart',
                  title: 'Execution Chart',
                  content: '{}',
                  version: 1,
                },
              ],
            },
            {
              id: 'tool-1',
              type: 'tool_call',
              content: '',
              timestamp: 150,
              toolCall: {
                id: 'tool-1',
                name: 'Write',
                args: {},
                result: 'ok',
                success: true,
                outputPath: '/repo/app/report.md',
                metadata: {
                  imagePath: '/repo/app/preview.png',
                },
              },
            },
          ],
        },
      ],
    };

    const enriched = buildTurnExecutionClarityProjection({
      projection,
      capabilities: {
        skills: [
          {
            kind: 'skill',
            id: 'draft-skill',
            label: 'draft-skill',
            selected: false,
            mounted: false,
            installState: 'available',
            description: 'Draft release notes',
            source: 'library',
            libraryId: 'community',
          },
        ],
        connectors: [
          {
            kind: 'connector',
            id: 'mail',
            label: 'Mail',
            selected: false,
            connected: false,
            detail: 'offline',
            capabilities: [],
          },
        ],
        mcpServers: [
          {
            kind: 'mcp',
            id: 'github',
            label: 'github',
            selected: false,
            status: 'error',
            enabled: true,
            transport: 'stdio',
            toolCount: 0,
            resourceCount: 0,
            error: 'auth failed',
          },
        ],
      },
      launchRequests: [],
      swarmEvents: [],
      routingEvents: [
        {
          kind: 'direct',
          mode: 'direct',
          timestamp: 100,
          turnMessageId: 'user-1',
          targetAgentIds: ['agent-reviewer'],
          targetAgentNames: ['reviewer'],
          deliveredTargetIds: ['agent-reviewer'],
          missingTargetIds: [],
        },
      ],
    });

    expect(enriched.turns[0]?.nodes.map((node) => node.type)).toEqual([
      'user',
      'turn_timeline',
      'turn_timeline',
      'assistant_text',
      'tool_call',
      'turn_timeline',
      'turn_timeline',
    ]);
    expect(enriched.turns[0]?.nodes[0]?.metadata?.workbench).toBeUndefined();
    expect(enriched.turns[0]?.nodes[1]?.turnTimeline?.kind).toBe('workbench_snapshot');
    expect(enriched.turns[0]?.nodes[1]?.turnTimeline?.snapshot?.executionIntent?.browserSessionMode).toBe('managed');
    expect(enriched.turns[0]?.nodes[1]?.turnTimeline?.snapshot?.executionIntent?.browserSessionSnapshot).toMatchObject({
      ready: true,
      preview: {
        title: 'Docs · Example',
        url: 'https://example.com/docs',
      },
    });
    expect(enriched.turns[0]?.nodes[2]?.turnTimeline?.kind).toBe('capability_scope');
    expect(enriched.turns[0]?.nodes[2]?.turnTimeline?.capabilityScope).toMatchObject({
      selected: [
        { kind: 'skill', id: 'draft-skill', label: 'draft-skill' },
        { kind: 'connector', id: 'mail', label: 'Mail' },
        { kind: 'mcp', id: 'github', label: 'github' },
      ],
      allowed: [],
      invoked: [],
    });
    expect(enriched.turns[0]?.nodes[2]?.turnTimeline?.capabilityScope?.blocked).toHaveLength(3);
    expect(enriched.turns[0]?.nodes[5]?.turnTimeline?.routingEvidence?.summary).toContain('Direct');
    expect(enriched.turns[0]?.nodes[6]?.turnTimeline?.artifactOwnership?.map((item) => item.label)).toEqual([
      'Execution Chart',
      'report.md',
      'preview.png',
    ]);
  });

  it('projects parallel routing evidence from launch requests and swarm events', () => {
    const enriched = buildTurnExecutionClarityProjection({
      projection: {
        sessionId: 'session-2',
        activeTurnIndex: -1,
        turns: [
          {
            turnNumber: 1,
            turnId: 'turn-1',
            status: 'completed',
            startTime: 200,
            endTime: 260,
            nodes: [
              {
                id: 'user-parallel',
                type: 'user',
                content: '并行处理这批改动',
                timestamp: 200,
                metadata: {
                  workbench: {
                    routingMode: 'parallel',
                  },
                },
              },
              {
                id: 'assistant-1',
                type: 'assistant_text',
                content: '准备并行拆分',
                timestamp: 220,
              },
            ],
          },
        ],
      },
      capabilities: {
        skills: [],
        connectors: [],
        mcpServers: [],
      },
      launchRequests: [
        {
          id: 'launch-1',
          sessionId: 'session-2',
          status: 'approved',
          requestedAt: 230,
          resolvedAt: 235,
          summary: '准备启动 3 个 agent',
          agentCount: 3,
          dependencyCount: 1,
          writeAgentCount: 1,
          tasks: [],
          feedback: '按计划启动',
        },
      ],
      swarmEvents: [
        {
          id: 'evt-start',
          sessionId: 'session-2',
          type: 'swarm:started',
          timestamp: 240,
          title: '编排开始',
          summary: '启动 3 个并行 agent',
          tone: 'neutral',
        },
      ],
      routingEvents: [],
    });

    const routingNode = enriched.turns[0]?.nodes.find((node) => node.turnTimeline?.kind === 'routing_evidence');
    expect(routingNode?.turnTimeline?.routingEvidence?.summary).toBe('并行编排已启动');
    expect(routingNode?.turnTimeline?.routingEvidence?.steps.map((step) => step.status)).toEqual([
      'requested',
      'approved',
      'started',
    ]);
  });

  it('projects auto routing evidence from session-scoped routing events', () => {
    const enriched = buildTurnExecutionClarityProjection({
      projection: {
        sessionId: 'session-auto',
        activeTurnIndex: -1,
        turns: [
          {
            turnNumber: 1,
            turnId: 'turn-1',
            status: 'completed',
            startTime: 300,
            endTime: 360,
            nodes: [
              {
                id: 'user-auto',
                type: 'user',
                content: '帮我判断该交给谁',
                timestamp: 300,
                metadata: {
                  workbench: {
                    routingMode: 'auto',
                  },
                },
              },
              {
                id: 'assistant-auto',
                type: 'assistant_text',
                content: '我来处理。',
                timestamp: 340,
              },
            ],
          },
        ],
      },
      capabilities: {
        skills: [],
        connectors: [],
        mcpServers: [],
      },
      launchRequests: [],
      swarmEvents: [],
      routingEvents: [
        {
          kind: 'auto',
          mode: 'auto',
          timestamp: 320,
          agentId: 'agent-reviewer',
          agentName: 'reviewer',
          reason: '该 agent 更适合做风险判断',
          score: 0.92,
          fallbackToDefault: false,
        },
      ],
    });

    const routingNode = enriched.turns[0]?.nodes.find((node) => node.turnTimeline?.kind === 'routing_evidence');
    expect(routingNode?.turnTimeline?.routingEvidence?.summary).toBe('Auto 已路由到 reviewer');
    expect(routingNode?.turnTimeline?.routingEvidence?.steps.map((step) => step.status)).toEqual([
      'resolved',
    ]);
    expect(routingNode?.turnTimeline?.routingEvidence?.reason).toBe('该 agent 更适合做风险判断');
  });

  it('reconstructs direct routing evidence from persisted metadata when runtime events are gone', () => {
    const enriched = buildTurnExecutionClarityProjection({
      projection: {
        sessionId: 'session-direct-persisted',
        activeTurnIndex: -1,
        turns: [
          {
            turnNumber: 1,
            turnId: 'turn-1',
            status: 'completed',
            startTime: 400,
            endTime: 460,
            nodes: [
              {
                id: 'user-direct-persisted',
                type: 'user',
                content: '只发给 reviewer',
                timestamp: 400,
                metadata: {
                  workbench: {
                    routingMode: 'direct',
                    targetAgentIds: ['agent-reviewer'],
                    targetAgentNames: ['reviewer'],
                    directRoutingDelivery: {
                      deliveredTargetIds: ['agent-reviewer'],
                      deliveredTargetNames: ['reviewer'],
                      missingTargetIds: ['agent-missing'],
                    },
                  },
                },
              },
              {
                id: 'assistant-direct-persisted',
                type: 'assistant_text',
                content: '已交给 reviewer。',
                timestamp: 430,
              },
            ],
          },
        ],
      },
      capabilities: {
        skills: [],
        connectors: [],
        mcpServers: [],
      },
      launchRequests: [],
      swarmEvents: [],
      routingEvents: [],
    });

    const routingNode = enriched.turns[0]?.nodes.find((node) => node.turnTimeline?.kind === 'routing_evidence');
    expect(routingNode?.turnTimeline?.routingEvidence?.summary).toBe('Direct 已发送，部分目标未命中');
    expect(routingNode?.turnTimeline?.routingEvidence?.steps.map((step) => step.status)).toEqual([
      'delivered',
      'missing',
    ]);
    expect(routingNode?.turnTimeline?.routingEvidence?.agentNames).toEqual(['reviewer']);
  });

  it('ignores parallel routing evidence from another session and keeps the current turn scoped', () => {
    const enriched = buildTurnExecutionClarityProjection({
      projection: {
        sessionId: 'session-1',
        activeTurnIndex: -1,
        turns: [
          {
            turnNumber: 1,
            turnId: 'turn-1',
            status: 'completed',
            startTime: 200,
            endTime: 260,
            nodes: [
              {
                id: 'user-parallel',
                type: 'user',
                content: '并行处理这批改动',
                timestamp: 200,
                metadata: {
                  workbench: {
                    routingMode: 'parallel',
                  },
                },
              },
              {
                id: 'assistant-1',
                type: 'assistant_text',
                content: '准备并行拆分',
                timestamp: 220,
              },
            ],
          },
        ],
      },
      capabilities: {
        skills: [],
        connectors: [],
        mcpServers: [],
      },
      launchRequests: [
        {
          id: 'launch-other-session',
          sessionId: 'session-2',
          status: 'approved',
          requestedAt: 230,
          resolvedAt: 235,
          summary: '别的会话准备启动 3 个 agent',
          agentCount: 3,
          dependencyCount: 1,
          writeAgentCount: 1,
          tasks: [],
          feedback: '别的会话已批准',
        },
      ],
      swarmEvents: [
        {
          id: 'evt-start-other-session',
          sessionId: 'session-2',
          type: 'swarm:started',
          timestamp: 240,
          title: '编排开始',
          summary: '启动 3 个并行 agent',
          tone: 'neutral',
        },
      ],
      routingEvents: [],
    });

    const routingNode = enriched.turns[0]?.nodes.find((node) => node.turnTimeline?.kind === 'routing_evidence');
    expect(routingNode?.turnTimeline?.routingEvidence?.summary).toBe('Parallel 意图已记录，但当前轮次没有出现 launch 证据');
    expect(routingNode?.turnTimeline?.routingEvidence?.steps.map((step) => step.status)).toEqual([
      'requested',
    ]);
  });
});
