import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { SwarmLaunchRequest } from '../../../src/shared/contract/swarm';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { encodeGoalNotice } from '../../../src/renderer/components/features/chat/goalNotice';
import { encodeModelFallbackNotice } from '../../../src/renderer/components/features/chat/fallbackNotice';

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
        runId: 'run-old',
        treeId: 'tree-old',
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
        runId: 'run-pending',
        treeId: 'tree-pending',
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

  it('projects model decisions onto assistant text nodes', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '你好',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '你好',
        timestamp: 150,
        modelDecision: {
          turnId: 'assistant-1',
          requestedProvider: 'moonshot',
          requestedModel: 'kimi-k2.5',
          resolvedProvider: 'zhipu',
          resolvedModel: 'glm-4.5-flash',
          reason: 'simple-task-free',
          role: null,
          billingMode: 'payg',
          fallbackFrom: null,
        },
      },
    ];

    const projection = projectTurns(messages, 'session-1', false, []);
    const assistantNode = projection.turns[0].nodes.find((node) => node.type === 'assistant_text');

    expect(assistantNode?.modelDecision?.reason).toBe('simple-task-free');
    expect(assistantNode?.modelDecision?.resolvedModel).toBe('glm-4.5-flash');
  });

  it('drops stale preamble content when contentParts are authoritative tool-only (no trailing text below tool)', () => {
    // 实时态：模型先吐 preamble 文本"使用Write工具来创建文件"，随后该消息被精简成
    // 纯工具调用（content_parts 只剩 tool_call，无 text part），但内存里旧 content 仍残留。
    // 不应把残留 content 作为尾随 assistant_text 节点追加到工具行之后。
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: '建个文件', timestamp: 100 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '使用Write工具来创建文件', // 残留 preamble（服务端已丢弃，落库 content 为空）
        timestamp: 150,
        toolCalls: [{ id: 'call_1', name: 'Write', arguments: { path: 'a.txt' } }],
        contentParts: [{ type: 'tool_call', toolCallId: 'call_1' }],
      },
    ];

    const projection = projectTurns(messages, 'session-1', false, []);
    const types = projection.turns[0].nodes.map((node) => node.type);
    expect(types).toEqual(['user', 'tool_call']);
    expect(types).not.toContain('assistant_text');
  });

  it('renders thinking BEFORE the tool node for a tool-only message (思考先于工具)', () => {
    // 纯工具调用消息(content_parts 仅 tool_call、无 text part)带 reasoning 时，
    // ▶思考 必须排在工具节点之前——否则"搜索完成"会显示在"第一轮思考"前面（顺序错）。
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: '搜一下', timestamp: 100 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 150,
        thinking: '我应该先联网搜索再总结。',
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: { query: 'x' } }],
        contentParts: [{ type: 'tool_call', toolCallId: 'call_1' }],
      },
    ];

    const projection = projectTurns(messages, 'session-1', false, []);
    const types = projection.turns[0].nodes.map((node) => node.type);
    expect(types).toEqual(['user', 'assistant_text', 'tool_call']);
    // 承载思考的合成节点保持稳定 id，供流式叠加层就地更新。
    const thinkingNode = projection.turns[0].nodes.find((n) => n.type === 'assistant_text');
    expect(thinkingNode?.id).toBe('assistant-1-text');
    expect(thinkingNode?.thinking).toBe('我应该先联网搜索再总结。');
  });

  it('still renders in-band text when contentParts include a text part', () => {
    // 对照：content_parts 有真实 text part 时，正文必须照常按交错顺序渲染。
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: '建个文件', timestamp: 100 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '我来创建文件',
        timestamp: 150,
        toolCalls: [{ id: 'call_1', name: 'Write', arguments: { path: 'a.txt' } }],
        contentParts: [
          { type: 'text', text: '我来创建文件' },
          { type: 'tool_call', toolCallId: 'call_1' },
        ],
      },
    ];

    const projection = projectTurns(messages, 'session-1', false, []);
    const types = projection.turns[0].nodes.map((node) => node.type);
    expect(types).toEqual(['user', 'assistant_text', 'tool_call']);
  });

  it('deduplicates identical model decisions but keeps changed strategy diagnostics', () => {
    const baseDecision = {
      requestedProvider: 'claude_code',
      requestedModel: 'sonnet',
      resolvedProvider: 'claude_code',
      resolvedModel: 'sonnet',
      reason: 'user-selected' as const,
      role: null,
      billingMode: 'unknown' as const,
      fallbackFrom: null,
      strategySummary: 'Claude Code 使用 sonnet 执行本轮任务。',
      taskClass: 'coding' as const,
      costPolicy: 'user-locked' as const,
      speedPolicy: 'normal' as const,
    };
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '继续写代码',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '我先检查。',
        timestamp: 150,
        modelDecision: baseDecision,
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '继续检查。',
        timestamp: 160,
        modelDecision: baseDecision,
      },
      {
        id: 'assistant-3',
        role: 'assistant',
        content: 'Claude Code 认证失败。',
        timestamp: 170,
        modelDecision: {
          ...baseDecision,
          externalEngine: {
            kind: 'claude_code',
            label: 'Claude Code',
            model: 'sonnet',
            installState: 'installed',
            runtimeState: 'ready',
            executable: true,
            capabilities: ['execute', 'stream_events'],
            reliability: {
              cliStatus: 'available',
              authState: 'not_checked',
              quotaState: 'not_checked',
              streamingMode: 'stream_json',
              toolSupport: 'read_only_cli_tools',
              transcriptMode: 'clean_stream_json',
            },
            failure: {
              category: 'auth',
              reason: 'auth_failed',
              message: 'Failed to authenticate',
              suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。',
              retryable: false,
              occurredAt: 60_000,
              statusCode: 401,
              exitCode: 1,
            },
          },
        },
      },
    ];

    const projection = projectTurns(messages, 'session-1', false, []);
    const assistantNodes = projection.turns[0].nodes.filter((node) => node.type === 'assistant_text');

    expect(assistantNodes).toHaveLength(3);
    expect(assistantNodes[0]?.modelDecision?.reason).toBe('user-selected');
    expect(assistantNodes[1]?.modelDecision).toBeUndefined();
    expect(assistantNodes[2]?.modelDecision?.externalEngine?.failure?.statusCode).toBe(401);
  });

  it('keeps model decisions when provider identity changes under the same route', () => {
    const baseDecision = {
      requestedProvider: 'custom-commonstack',
      requestedModel: 'anthropic/claude-opus-4-8',
      resolvedProvider: 'custom-commonstack',
      resolvedModel: 'anthropic/claude-opus-4-8',
      reason: 'user-selected' as const,
      role: null,
      billingMode: 'unknown' as const,
      fallbackFrom: null,
    };
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: '继续写代码', timestamp: 100 },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '第一轮。',
        timestamp: 150,
        modelDecision: {
          ...baseDecision,
          providerIdentity: {
            provider: 'custom-commonstack',
            sourceLabel: 'CommonStack',
            protocol: 'openai',
            transportLabel: 'OpenAI-compatible',
            endpoint: 'https://commonstack.example/v1',
          },
        },
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '第二轮。',
        timestamp: 160,
        modelDecision: {
          ...baseDecision,
          providerIdentity: {
            provider: 'custom-commonstack',
            sourceLabel: 'CommonStack',
            protocol: 'openai',
            transportLabel: 'OpenAI-compatible',
            endpoint: 'https://commonstack-backup.example/v1',
          },
        },
      },
    ];

    const projection = projectTurns(messages, 'session-1', false, []);
    const assistantNodes = projection.turns[0].nodes.filter((node) => node.type === 'assistant_text');

    expect(assistantNodes).toHaveLength(2);
    expect(assistantNodes[0]?.modelDecision?.providerIdentity?.endpoint).toBe('https://commonstack.example/v1');
    expect(assistantNodes[1]?.modelDecision?.providerIdentity?.endpoint).toBe('https://commonstack-backup.example/v1');
  });

  it('projects model fallback notices as system nodes in the current turn', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '看这张图',
        timestamp: 100,
      },
      {
        id: 'fallback-1',
        role: 'system',
        source: 'model',
        content: encodeModelFallbackNotice({
          reason: 'vision',
          from: 'kimi-k2.5',
          to: 'glm-4.5v',
        }),
        timestamp: 130,
      },
    ];

    const projection = projectTurns(messages, 'session-1', false, []);
    const fallbackNode = projection.turns[0].nodes.find((node) => node.subtype === 'model_fallback');

    expect(fallbackNode?.type).toBe('system');
    expect(fallbackNode?.content).toContain('__modelFallbackNotice');
  });

  it('creates a standalone turn when only a pending launch request exists', () => {
    const launchRequests: SwarmLaunchRequest[] = [
      {
        id: 'launch-only',
        sessionId: 'session-2',
        runId: 'run-only',
        treeId: 'tree-only',
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
        runId: 'run-approved',
        treeId: 'tree-approved',
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

  it('starts a new turn for queued runtime supplements', () => {
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
        content: '第一轮分析完成',
        timestamp: 180,
      },
      {
        id: 'user-2',
        role: 'user',
        content: '按客户读者重新整理',
        timestamp: 240,
        metadata: {
          workbench: {
            runtimeInputMode: 'supplement',
            runtimeInputDelivery: 'queued_next_turn',
          },
        },
      },
    ];

    const projection = projectTurns(messages, 'session-4', true, []);

    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[0].nodes.map((node) => node.id)).toEqual([
      'user-1',
      'assistant-1-text',
    ]);
    expect(projection.turns[1].nodes.map((node) => node.id)).toEqual([
      'user-2',
    ]);
    expect(projection.activeTurnIndex).toBe(1);
  });

  it('keeps skill status inside the current turn instead of creating a new user turn', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '帮我做飞书文档',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 130,
        toolCalls: [
          {
            id: 'call-skill-1',
            name: 'skill',
            arguments: {
              command: 'lark-doc',
            },
            result: {
              toolCallId: 'call-skill-1',
              success: true,
              output: 'Skill "lark-doc" activated. Follow the skill instructions.',
            },
          },
        ],
      },
      {
        id: 'skill-status-1',
        role: 'user',
        content: '<command-message>Loading skill: lark-doc</command-message><command-name>lark-doc</command-name>',
        timestamp: 150,
        source: 'skill',
        metadata: {
          skill: {
            skillName: 'lark-doc',
            phase: 'status',
          },
        },
      },
      {
        id: 'skill-instructions-1',
        role: 'user',
        content: 'Skill instructions',
        timestamp: 151,
        source: 'skill',
        isMeta: true,
        metadata: {
          skill: {
            skillName: 'lark-doc',
            phase: 'instructions',
          },
        },
      },
    ];

    const projection = projectTurns(messages, 'session-skill', false, []);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].nodes.map((node) => node.id)).toEqual([
      'user-1',
      'assistant-1-tc-call-skill-1',
      'skill-status-1',
    ]);
    expect(projection.turns[0].nodes[2]?.type).toBe('system');
    expect(projection.turns[0].nodes[2]?.subtype).toBe('skill_status');
  });

  it('keeps automation meta feedback visible without exposing other meta messages', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '/schedule 每 15 分钟巡检主题页',
        timestamp: 100,
      },
      {
        id: 'automation:created:cron:job-1',
        role: 'assistant',
        source: 'automation',
        content: '自动化已创建：主题页编排巡检\n频率：每 15 分钟',
        timestamp: 110,
        isMeta: true,
        metadata: {
          automation: {
            automationId: 'cron:job-1',
            automationType: 'cron',
            event: 'created',
            sourceSessionId: 'session-1',
            sourceRefId: 'job-1',
            status: 'active',
            title: '主题页编排巡检',
            cadenceLabel: '每 15 分钟',
          },
        },
      },
      {
        id: 'hidden-meta-1',
        role: 'assistant',
        content: 'hidden internal note',
        timestamp: 111,
        isMeta: true,
      },
    ];

    const projection = projectTurns(messages, 'session-1', false, []);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].nodes.map((node) => node.id)).toEqual([
      'user-1',
      'automation:created:cron:job-1-automation',
    ]);
    expect(projection.turns[0].nodes[1]).toMatchObject({
      type: 'assistant_text',
      content: expect.stringContaining('自动化已创建'),
      metadata: {
        automation: {
          automationId: 'cron:job-1',
          event: 'created',
        },
      },
    });
  });

  it('keeps goal lifecycle notices inside the current turn', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '修好登录',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '已修好。',
        timestamp: 150,
      },
      {
        id: 'goal-met-1',
        role: 'system',
        content: encodeGoalNotice({
          kind: 'met',
          goal: '修好登录',
          turns: 2,
          tokensUsed: 1234,
          durationMs: 2500,
        }),
        timestamp: 180,
        source: 'goal',
      },
    ];

    const projection = projectTurns(messages, 'session-goal', false, []);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].nodes.map((node) => node.id)).toEqual([
      'user-1',
      'assistant-1-text',
      'goal-met-1',
    ]);
    expect(projection.turns[0].nodes[2]?.type).toBe('system');
    expect(projection.turns[0].nodes[2]?.subtype).toBe('goal_notice');
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

  it('keeps a reasoning-only assistant node visible during streaming flushes', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '先思考',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        reasoning: '正在分析约束和上下文',
        timestamp: 130,
        toolCalls: [],
      },
    ];

    const projection = projectTurns(messages, 'session-thinking', true, []);

    expect(projection.turns).toHaveLength(1);
    expect(projection.activeTurnIndex).toBe(0);
    expect(projection.turns[0].nodes.map((node) => node.id)).toEqual([
      'user-1',
      'assistant-1-text',
    ]);
    expect(projection.turns[0].nodes[1]).toMatchObject({
      type: 'assistant_text',
      content: '',
      reasoning: '正在分析约束和上下文',
    });
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
        runId: 'run-other-session',
        treeId: 'tree-other-session',
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

  it('preserves pending tool live output on tool call nodes', () => {
    const messages: Message[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 130,
        toolCalls: [
          {
            id: 'call-bash-1',
            name: 'Bash',
            arguments: {
              command: 'npm test',
            },
            liveOutput: {
              stdout: 'running tests\n',
              updatedAt: 200,
            },
          },
        ],
      },
    ];

    const projection = projectTurns(messages, 'session-live-output', true, []);
    const toolNode = projection.turns[0]?.nodes.find((node) => node.type === 'tool_call');

    expect(toolNode?.toolCall?.liveOutput).toMatchObject({
      stdout: 'running tests\n',
      updatedAt: 200,
    });
  });

  it('marks only the final assistant text in a completed turn as feedback eligible', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '用 workflow 派一个 reviewer 审查',
        timestamp: 100,
      },
      {
        id: 'assistant-progress',
        role: 'assistant',
        content: '我先使用 workflow_orchestrate 派出只读 reviewer。',
        timestamp: 150,
        toolCalls: [
          {
            id: 'tool-workflow',
            name: 'workflow_orchestrate',
            arguments: { workflow: 'custom' },
            result: {
              toolCallId: 'tool-workflow',
              success: true,
              output: 'ok',
            },
          },
        ],
      },
      {
        id: 'assistant-final',
        role: 'assistant',
        content: '审查完成，可以继续推进。',
        timestamp: 200,
      },
    ];

    const projection = projectTurns(messages, 'session-feedback', false, []);
    const assistantNodes = projection.turns[0].nodes.filter((node) => node.type === 'assistant_text');

    expect(assistantNodes.map((node) => node.feedbackEligible)).toEqual([false, true]);
  });

  it('does not mark process text before tool calls as feedback eligible', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '用 workflow 派一个 reviewer 审查',
        timestamp: 100,
      },
      {
        id: 'assistant-progress',
        role: 'assistant',
        content: '我先使用 workflow_orchestrate 派出只读 reviewer。',
        timestamp: 150,
        toolCalls: [
          {
            id: 'tool-workflow',
            name: 'workflow_orchestrate',
            arguments: { workflow: 'custom' },
            result: {
              toolCallId: 'tool-workflow',
              success: true,
              output: 'ok',
            },
          },
        ],
      },
    ];

    const projection = projectTurns(messages, 'session-progress-feedback', false, []);
    const assistantNodes = projection.turns[0].nodes.filter((node) => node.type === 'assistant_text');

    expect(assistantNodes.map((node) => node.feedbackEligible)).toEqual([false]);
  });

  it('marks final text after ordered tool calls as feedback eligible', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '跑一次 workflow',
        timestamp: 100,
      },
      {
        id: 'assistant-final-with-tool',
        role: 'assistant',
        content: 'workflow_orchestrate 已完成，结果可以继续看。',
        timestamp: 150,
        toolCalls: [
          {
            id: 'tool-workflow',
            name: 'workflow_orchestrate',
            arguments: { workflow: 'custom' },
            result: {
              toolCallId: 'tool-workflow',
              success: true,
              output: 'ok',
            },
          },
        ],
        contentParts: [
          { type: 'tool_call', toolCallId: 'tool-workflow' },
          { type: 'text', text: 'workflow_orchestrate 已完成，结果可以继续看。' },
        ],
      },
    ];

    const projection = projectTurns(messages, 'session-final-feedback', false, []);

    expect(projection.turns[0].nodes.map((node) => node.type)).toEqual([
      'user',
      'tool_call',
      'assistant_text',
    ]);

    const assistantNodes = projection.turns[0].nodes.filter((node) => node.type === 'assistant_text');
    expect(assistantNodes.map((node) => node.feedbackEligible)).toEqual([true]);
  });

  it('marks a recovered web-search failure but leaves an unrelated edit failure visible', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '搜一下 codex 更新', timestamp: 100 },
      {
        id: 'a1', role: 'assistant', content: '', timestamp: 110,
        toolCalls: [{
          id: 'tc-search', name: 'WebSearch', arguments: {},
          result: { toolCallId: 'tc-search', success: false, error: 'All search sources failed' },
        }],
      },
      {
        id: 'a2', role: 'assistant', content: '', timestamp: 120,
        toolCalls: [{
          id: 'tc-fetch', name: 'WebFetch', arguments: {},
          result: { toolCallId: 'tc-fetch', success: true, output: 'ok' },
        }],
      },
      { id: 'a3', role: 'assistant', content: '找到了：codex 更新内容…', timestamp: 130 },
      {
        id: 'a4', role: 'assistant', content: '', timestamp: 140,
        toolCalls: [{
          id: 'tc-edit', name: 'Edit', arguments: {},
          result: { toolCallId: 'tc-edit', success: false, error: 'patch failed' },
        }],
      },
      { id: 'a5', role: 'assistant', content: '改完了', timestamp: 150 },
    ];

    const projection = projectTurns(messages, 'session-1', false, []);
    const nodes = projection.turns.flatMap((turn) => turn.nodes);
    const search = nodes.find((node) => node.toolCall?.id === 'tc-search');
    const edit = nodes.find((node) => node.toolCall?.id === 'tc-edit');

    // 联网检索失败后又成功 + 出最终答案 → 降级为 recovered
    expect(search?.toolCall?.recovered).toBe(true);
    // 独立的 Edit 失败即便后面有成功，也不降级（避免藏掉真失败）
    expect(edit?.toolCall?.recovered).toBeFalsy();
  });
});
