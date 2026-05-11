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
    expect(enriched.turns[0]?.nodes[3]?.turnTimeline?.kind).toBe('skill_activity');
    expect(enriched.turns[0]?.nodes[3]?.turnTimeline?.skillActivity?.summary).toBe('Skill 写入偏好 1');
    expect(enriched.turns[0]?.nodes[6]?.turnTimeline?.routingEvidence?.summary).toContain('Direct');
    expect(enriched.turns[0]?.nodes[7]?.turnTimeline?.artifactOwnership?.map((item) => item.label)).toEqual([
      'Execution Chart',
      'report.md',
      'preview.png',
    ]);
  });

  it('projects structured tool artifact metadata into artifact ownership', () => {
    const enriched = buildTurnExecutionClarityProjection({
      projection: {
        sessionId: 'session-artifact',
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
                content: '读取报告并查资料',
                timestamp: 100,
              },
              {
                id: 'tool-read',
                type: 'tool_call',
                content: '',
                timestamp: 130,
                toolCall: {
                  id: 'call-read-1',
                  name: 'Read',
                  args: {
                    path: '/repo/app/report.md',
                  },
                  result: '# Report',
                  success: true,
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
                    artifacts: [
                      {
                        artifactId: 'artifact-search-result',
                        kind: 'web',
                        sourceTool: 'WebSearch',
                        createdAt: '2026-05-07T00:00:01.000Z',
                        name: 'Search results',
                        url: 'https://example.com/search?q=artifact',
                        preview: 'Search result preview',
                      },
                    ],
                  },
                },
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

    const artifactNode = enriched.turns[0]?.nodes.find((node) => node.turnTimeline?.kind === 'artifact_ownership');

    expect(artifactNode?.turnTimeline?.artifactOwnership).toEqual([
      {
        kind: 'link',
        label: 'Search results',
        ownerKind: 'tool',
        ownerLabel: 'WebSearch',
        path: undefined,
        url: 'https://example.com/search?q=artifact',
        sourceNodeId: 'tool-read',
      },
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

  it('projects unified tool artifact metadata into artifact ownership timeline nodes', () => {
    const enriched = buildTurnExecutionClarityProjection({
      projection: {
        sessionId: 'session-artifacts',
        activeTurnIndex: -1,
        turns: [
          {
            turnNumber: 1,
            turnId: 'turn-artifacts',
            status: 'completed',
            startTime: 180,
            endTime: 240,
            nodes: [
              {
                id: 'user-artifacts',
                type: 'user',
                content: '抓取并整理材料',
                timestamp: 180,
              },
              {
                id: 'tool-artifacts',
                type: 'tool_call',
                content: '',
                timestamp: 220,
                toolCall: {
                  id: 'tool-artifacts',
                  name: 'WebFetch',
                  args: {},
                  result: 'ok',
                  success: true,
                  metadata: {
                    artifact: {
                      artifactId: 'artifact-source',
                      kind: 'web',
                      sourceTool: 'WebFetch',
                      name: 'Source page',
                      url: 'https://example.com/source',
                    },
                    artifacts: [
                      {
                        artifactId: 'artifact-notes',
                        kind: 'text',
                        sourceTool: 'WebFetch',
                        name: 'Fetch notes',
                      },
                      {
                        artifactId: 'artifact-file',
                        kind: 'document',
                        sourceTool: 'WebFetch',
                        name: 'Fetched PDF',
                        path: '/repo/app/source.pdf',
                      },
                    ],
                  },
                },
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

    const artifactNode = enriched.turns[0]?.nodes.find((node) => node.turnTimeline?.kind === 'artifact_ownership');
    expect(artifactNode?.turnTimeline?.artifactOwnership).toEqual([
      {
        kind: 'link',
        label: 'Source page',
        ownerKind: 'tool',
        ownerLabel: 'WebFetch',
        path: undefined,
        url: 'https://example.com/source',
        sourceNodeId: 'tool-artifacts',
      },
      {
        kind: 'file',
        label: 'Fetched PDF',
        ownerKind: 'tool',
        ownerLabel: 'WebFetch',
        path: '/repo/app/source.pdf',
        url: undefined,
        sourceNodeId: 'tool-artifacts',
      },
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

  it('injects hook activity into the conversation turn timeline', () => {
    const enriched = buildTurnExecutionClarityProjection({
      projection: {
        sessionId: 'session-hooks',
        activeTurnIndex: -1,
        turns: [
          {
            turnNumber: 1,
            turnId: 'turn-1',
            status: 'completed',
            startTime: 120,
            endTime: 180,
            nodes: [
              {
                id: 'user-hooks',
                type: 'user',
                content: '运行一下 hook',
                timestamp: 100,
              },
              {
                id: 'assistant-hooks',
                type: 'assistant_text',
                content: 'done',
                timestamp: 160,
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
      hookEvents: [
        {
          timestamp: 110,
          event: 'UserPromptSubmit',
          action: 'allow',
          durationMs: 4,
          hookCount: 1,
          modified: false,
          message: 'prompt hook passed',
        },
        {
          timestamp: 150,
          event: 'PreToolUse',
          action: 'allow',
          durationMs: 7,
          hookCount: 2,
          modified: true,
          toolName: 'Bash',
        },
      ],
    });

    expect(enriched.turns[0]?.nodes.map((node) => node.type)).toEqual([
      'user',
      'turn_timeline',
      'assistant_text',
    ]);
    const hookNode = enriched.turns[0]?.nodes[1];
    expect(hookNode?.turnTimeline?.kind).toBe('hook_activity');
    expect(hookNode?.turnTimeline?.hookActivity?.summary).toContain('命中 3 个 hook');
    expect(hookNode?.turnTimeline?.hookActivity?.items.map((item) => item.event)).toEqual([
      'UserPromptSubmit',
      'PreToolUse',
    ]);
  });

  it('projects skill trigger and instruction write activity into the current turn', () => {
    const enriched = buildTurnExecutionClarityProjection({
      projection: {
        sessionId: 'session-skill',
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
                content: '帮我写飞书文档',
                timestamp: 100,
              },
              {
                id: 'tool-skill',
                type: 'tool_call',
                content: '',
                timestamp: 130,
                toolCall: {
                  id: 'call-skill-1',
                  name: 'skill',
                  args: {
                    command: 'lark-doc',
                  },
                  result: 'Skill "lark-doc" activated. Follow the skill instructions.',
                  success: true,
                  metadata: {
                    skillName: 'lark-doc',
                    source: 'user',
                    executionContext: 'inline',
                    isSkillActivation: true,
                    skillResult: {
                      success: true,
                      data: { commandName: 'lark-doc' },
                      newMessages: [
                        {
                          role: 'user',
                          content: '<command-message>Loading skill: lark-doc</command-message><command-name>lark-doc</command-name>',
                          isMeta: false,
                        },
                        {
                          role: 'user',
                          content: 'Skill instructions',
                          isMeta: true,
                        },
                      ],
                    },
                  },
                },
              },
              {
                id: 'skill-status-1',
                type: 'system',
                content: '<command-message>Loading skill: lark-doc</command-message><command-name>lark-doc</command-name>',
                timestamp: 150,
                subtype: 'skill_status',
                metadata: {
                  skill: {
                    skillName: 'lark-doc',
                    phase: 'status',
                  },
                },
              },
              {
                id: 'assistant-1',
                type: 'assistant_text',
                content: '继续执行。',
                timestamp: 160,
              },
            ],
          },
        ],
      },
      capabilities: {
        skills: [
          {
            kind: 'skill',
            id: 'lark-doc',
            label: 'lark-doc',
            selected: false,
            mounted: true,
            installState: 'mounted',
            description: '飞书文档',
            source: 'user',
            libraryId: 'local',
          },
        ],
        connectors: [],
        mcpServers: [],
      },
      launchRequests: [],
      swarmEvents: [],
      routingEvents: [],
    });

    const skillNode = enriched.turns[0]?.nodes.find((node) => node.turnTimeline?.kind === 'skill_activity');

    expect(skillNode?.turnTimeline?.skillActivity?.summary).toBe('Skill 触发 1 · 写入 1');
    expect(skillNode?.turnTimeline?.skillActivity?.items.map((item) => item.action)).toEqual([
      'triggered',
      'written',
    ]);
  });
});
