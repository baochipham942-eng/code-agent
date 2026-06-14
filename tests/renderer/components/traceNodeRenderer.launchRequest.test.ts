import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { SwarmLaunchRequest } from '../../../src/shared/contract/swarm';
import type { TurnTimelineNode } from '../../../src/shared/contract/turnTimeline';
import { encodeModelFallbackNotice } from '../../../src/renderer/components/features/chat/fallbackNotice';

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/MessageContent', () => ({
  MessageContent: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/index', () => ({
  ToolCallDisplay: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview', () => ({
  AttachmentDisplay: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ExpandableContent', () => ({
  ExpandableContent: () => null,
}));

import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

function makeLaunchRequest(overrides: Partial<SwarmLaunchRequest> = {}): SwarmLaunchRequest {
  return {
    id: 'launch-1',
    status: 'pending',
    requestedAt: 200,
    summary: '准备启动 3 个 agent',
    agentCount: 3,
    dependencyCount: 2,
    writeAgentCount: 1,
    tasks: [
      {
        id: 'task-builder',
        role: 'builder',
        task: '负责主实现',
        tools: ['bash', 'apply_patch'],
        writeAccess: true,
      },
      {
        id: 'task-qa',
        role: 'qa',
        task: '负责回归验证',
        dependsOn: ['task-builder'],
        tools: ['npm', 'vitest'],
        writeAccess: false,
      },
    ],
    ...overrides,
  };
}

function makeNode(request: SwarmLaunchRequest): TraceNode {
  return {
    id: `node-${request.id}`,
    type: 'swarm_launch_request',
    content: '',
    timestamp: request.requestedAt,
    launchRequest: request,
  };
}

describe('TraceNodeRenderer launch request', () => {
  it('marks queued runtime steer user messages as guided dialogue', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'user-guided-1',
          type: 'user',
          content: '我说的不是评测，而是刚才你说不走的地方',
          timestamp: 100,
          metadata: {
            workbench: {
              runtimeInputMode: 'supplement',
              runtimeInputDelivery: 'queued_next_turn',
            },
          },
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('已引导对话');
  });

  it('renders pending launch request as an inline approval card', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: makeNode(makeLaunchRequest()),
      }),
    );

    expect(html).toContain('准备 spawn 3 个 agent');
    expect(html).toContain('待确认');
    expect(html).toContain('准备启动 3 个 agent');
    expect(html).toContain('开始执行');
    expect(html).toContain('取消编排');
    expect(html).toContain('builder');
    expect(html).toContain('qa');
    expect(html).toContain('bash');
    expect(html).toContain('依赖 task-builder');
  });

  it('renders resolved request feedback without action buttons', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: makeNode(
          makeLaunchRequest({
            status: 'approved',
            feedback: '按计划启动',
          }),
        ),
      }),
    );

    expect(html).toContain('已启动');
    expect(html).toContain('按计划启动');
    expect(html).not.toContain('开始执行');
    expect(html).not.toContain('取消编排');
  });

  it('renders user workbench routing badges inline', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'user-direct-1',
          type: 'user',
          content: '把这个回归任务交给 reviewer',
          timestamp: 320,
          metadata: {
            workbench: {
              workingDirectory: '/repo/app',
              routingMode: 'direct',
              targetAgentNames: ['reviewer'],
              executionIntent: {
                browserSessionMode: 'managed',
                preferBrowserSession: true,
                allowBrowserAutomation: true,
              },
              selectedSkillIds: ['review-skill'],
              selectedConnectorIds: ['mail'],
              selectedMcpServerIds: ['github'],
            },
          },
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('WS app');
    expect(html).toContain('Direct');
    expect(html).toContain('@reviewer');
    expect(html).toContain('Skill review-skill');
    expect(html).toContain('Connector mail');
    expect(html).toContain('MCP github');
    expect(html).toContain('Browser Managed');
  });

  it('renders model decision route chip on assistant text', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'assistant-route-1',
          messageId: 'turn-1',
          type: 'assistant_text',
          content: '你好',
          timestamp: 420,
          modelDecision: {
            turnId: 'turn-1',
            requestedProvider: 'moonshot',
            requestedModel: 'kimi-k2.5',
            resolvedProvider: 'zhipu',
            resolvedModel: 'glm-4.5-flash',
            reason: 'simple-task-free',
            role: null,
            billingMode: 'payg',
            fallbackFrom: null,
          },
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('简单任务');
    expect(html).toContain('kimi-k2.5');
    expect(html).toContain('glm-4.5-flash');
  });

  it('expands external engine failure details on assistant text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(180_000);

    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'assistant-engine-failure-1',
          messageId: 'turn-engine-failure',
          type: 'assistant_text',
          content: 'Claude Code 认证失败。',
          timestamp: 520,
          modelDecision: {
            turnId: 'turn-engine-failure',
            requestedProvider: 'claude_code',
            requestedModel: 'sonnet',
            resolvedProvider: 'claude_code',
            resolvedModel: 'sonnet',
            reason: 'user-selected',
            role: null,
            billingMode: 'unknown',
            fallbackFrom: null,
            strategySummary: 'Claude Code 订阅链路失败，本轮未能完成请求。',
            taskClass: 'coding',
            costPolicy: 'user-locked',
            speedPolicy: 'normal',
            toolPolicy: 'runtime-checked',
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
                message: 'Failed to authenticate. API Error: 401',
                suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。',
                retryable: false,
                occurredAt: 60_000,
                statusCode: 401,
                exitCode: 1,
                reliability: { authState: 'needs_login' },
              },
            },
          },
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('Claude Code 订阅链路失败');
    expect(html).toContain('auth · auth_failed · 2 分钟前失败 · HTTP 401 · exit 1 · 需处理');
    expect(html).toContain('Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。');
    vi.useRealTimers();
  });

  it('renders model fallback banner inline', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'fallback-1',
          type: 'system',
          content: encodeModelFallbackNotice({
            reason: 'vision',
            from: 'moonshot/kimi-k2.5',
            to: 'zhipu/glm-4.5v',
            tried: [
              {
                provider: 'moonshot',
                model: 'kimi-k2.5',
                status: 'tried',
                reason: 'missing_capability',
                category: 'vision',
              },
              {
                provider: 'zhipu',
                model: 'glm-4.5v',
                status: 'selected',
                reason: 'capability_fallback_selected',
                category: 'vision',
              },
            ],
            skipped: [
              {
                provider: 'openai',
                model: 'gpt-5.4-mini',
                status: 'skipped',
                reason: 'missing_api_key',
                category: 'vision',
              },
            ],
            toolPolicy: {
              status: 'disabled',
              reason: 'fallback_model_without_tool_support',
              originalToolCount: 3,
              effectiveToolCount: 0,
              disabledToolNames: ['Read', 'Edit', 'Bash'],
            },
          }),
          timestamp: 520,
          subtype: 'model_fallback',
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('模型已降级');
    expect(html).toContain('kimi-k2.5');
    expect(html).toContain('glm-4.5v');
    expect(html).toContain('已尝试');
    expect(html).toContain('已跳过');
    expect(html).toContain('已选用');
    expect(html).toContain('gpt-5.4-mini');
    expect(html).toContain('工具已关闭');
    expect(html).toContain('3');
  });

  it('renders exhausted fallback traces inline', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'fallback-exhausted-1',
          type: 'system',
          content: encodeModelFallbackNotice({
            reason: 'Moonshot API error: 503 service unavailable',
            category: 'provider_unavailable',
            from: 'zhipu/glm-4.7-flash',
            to: '未切换',
            tried: [
              {
                provider: 'zhipu',
                model: 'glm-4.7-flash',
                status: 'tried',
                reason: 'adaptive_candidate_failed',
                category: 'rate_limit',
              },
              {
                provider: 'moonshot',
                model: 'kimi-k2.5',
                status: 'exhausted',
                reason: 'main_task_model_failed',
                category: 'provider_unavailable',
              },
            ],
          }),
          timestamp: 540,
          subtype: 'model_fallback',
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('模型已降级');
    expect(html).toContain('未切换');
    expect(html).toContain('已耗尽');
    expect(html).toContain('kimi-k2.5');
  });

  it('renders a prompt rewind action beside user prompts', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'user-rewind-1',
          type: 'user',
          content: '把这轮重新改一下',
          timestamp: 320,
        } satisfies TraceNode,
        onRewindUserPrompt: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="回到这条提示词"');
    expect(html).toContain('title="回到这条提示词"');
    expect(html).toContain('group/user-prompt');
    expect(html).toContain('opacity-0');
    expect(html).toContain('group-hover/user-prompt:opacity-100');
  });

  it('keeps user prompt selection on the text content instead of the bubble chrome', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'user-selectable',
          type: 'user',
          content: '只选这里的文字',
          timestamp: 322,
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('class="rounded-2xl px-4 py-2.5 bg-zinc-800/60 border border-white/[0.06]"');
    expect(html).toContain('class="text-zinc-200 leading-relaxed select-text"');
    expect(html).not.toContain('border border-white/[0.06] select-text');
  });

  it('does not render assistant copy controls until text is selected', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'assistant-copy-hidden',
          type: 'assistant_text',
          content: '选中文本后才出现复制按钮',
          timestamp: 323,
        } satisfies TraceNode,
      }),
    );

    expect(html).not.toContain('复制选中文本');
  });

  it('disables the prompt rewind action while the session is processing', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'user-rewind-disabled',
          type: 'user',
          content: '运行中不能回退',
          timestamp: 321,
        } satisfies TraceNode,
        onRewindUserPrompt: vi.fn(),
        rewindDisabled: true,
      }),
    );

    expect(html).toContain('title="会话运行中，暂不能回退"');
    expect(html).toContain('disabled=""');
  });

  it('renders turn timeline cards for capability scope and outputs', () => {
    const snapshotTimeline: TurnTimelineNode = {
      id: 'timeline-snapshot',
      kind: 'workbench_snapshot',
      timestamp: 390,
      tone: 'warning',
      snapshot: {
        executionIntent: {
          browserSessionMode: 'desktop',
          preferBrowserSession: true,
          preferDesktopContext: true,
          allowBrowserAutomation: false,
          browserSessionSnapshot: {
            ready: false,
            blockedDetail: '当前桌面浏览器上下文未就绪：屏幕录制未授权。',
            blockedHint: '先去授权屏幕录制。',
            preview: {
              title: 'ChatGPT',
              url: 'https://chatgpt.com',
              frontmostApp: 'Google Chrome',
              lastScreenshotAtMs: Date.UTC(2026, 3, 17, 8, 30, 0),
            },
          },
        },
      },
    };
    const scopeTimeline: TurnTimelineNode = {
      id: 'timeline-scope',
      kind: 'capability_scope',
      timestamp: 400,
      tone: 'warning',
      capabilityScope: {
        selected: [
          {
            kind: 'skill',
            id: 'draft-skill',
            label: 'draft-skill',
          },
        ],
        allowed: [],
        blocked: [
          {
            kind: 'skill',
            id: 'draft-skill',
            label: 'draft-skill',
            code: 'skill_not_mounted',
            detail: 'Skill draft-skill 已安装但未挂载，本轮不会调用。',
            hint: '去 TaskPanel/Skills 把它挂到当前会话。',
            severity: 'warning',
          },
        ],
        invoked: [
          {
            kind: 'connector',
            id: 'mail',
            label: 'Mail',
            count: 1,
            topActions: [
              {
                label: 'send',
                count: 1,
              },
            ],
          },
        ],
      },
    };

    const outputsTimeline: TurnTimelineNode = {
      id: 'timeline-output',
      kind: 'artifact_ownership',
      timestamp: 420,
      tone: 'success',
      artifactOwnership: [
        {
          kind: 'file',
          label: 'report.md',
          ownerKind: 'tool',
          ownerLabel: 'reviewer · Write',
        },
      ],
    };

    const html = renderToStaticMarkup(
        React.createElement(React.Fragment, null,
        React.createElement(TraceNodeRenderer, {
          node: {
            id: 'timeline-snapshot-node',
            type: 'turn_timeline',
            content: '',
            timestamp: 390,
            turnTimeline: snapshotTimeline,
          } satisfies TraceNode,
        }),
        React.createElement(TraceNodeRenderer, {
          node: {
            id: 'timeline-scope-node',
            type: 'turn_timeline',
            content: '',
            timestamp: 400,
            turnTimeline: scopeTimeline,
          } satisfies TraceNode,
        }),
        React.createElement(TraceNodeRenderer, {
          node: {
            id: 'timeline-output-node',
            type: 'turn_timeline',
            content: '',
            timestamp: 420,
            turnTimeline: outputsTimeline,
          } satisfies TraceNode,
        }),
      ),
    );

    expect(html).not.toContain('本轮执行快照');
    expect(html).not.toContain('Browser Blocked');
    expect(html).not.toContain('能力范围');
    expect(html).not.toContain('用户选择');
    expect(html).not.toContain('运行时阻塞');
    expect(html).not.toContain('实际调用');
    expect(html).not.toContain('skill_not_mounted');
    expect(html).not.toContain('Mail');
    expect(html).not.toContain('send');
    expect(html).toContain('report.md');
    expect(html).toContain('Created');
  });

  it('does not render capability scope timeline nodes in the chat stream', () => {
    const invokedOnlyScope: TurnTimelineNode = {
      id: 'timeline-scope',
      kind: 'capability_scope',
      timestamp: 400,
      tone: 'info',
      capabilityScope: {
        selected: [],
        allowed: [],
        blocked: [],
        invoked: [
          {
            kind: 'skill',
            id: 'doctor',
            label: 'doctor',
            count: 2,
            topActions: [],
          },
        ],
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'timeline-scope-node',
          type: 'turn_timeline',
          content: '',
          timestamp: 400,
          turnTimeline: invokedOnlyScope,
        } satisfies TraceNode,
      }),
    );

    expect(html).toBe('');
    expect(html).not.toContain('实际调用');
    expect(html).not.toContain('调用明细');
    expect(html).not.toContain('doctor');
    expect(html).not.toContain('invoked');
    expect(html).not.toContain('用户选择');
    expect(html).not.toContain('运行时放行');
    expect(html).not.toContain('运行时阻塞');
  });

  it('renders hook activity timeline nodes collapsed by default', () => {
    const hookTimeline: TurnTimelineNode = {
      id: 'timeline-hooks',
      kind: 'hook_activity',
      timestamp: 500,
      tone: 'success',
      hookActivity: {
        summary: '命中 2 个 hook · 已放行 · 12ms',
        items: [
          {
            timestamp: 501,
            event: 'UserPromptSubmit',
            action: 'allow',
            hookCount: 1,
            durationMs: 4,
            sources: ['global'],
            hookType: 'observer',
            message: 'prompt hook passed',
          },
          {
            timestamp: 502,
            event: 'PreToolUse',
            action: 'allow',
            hookCount: 1,
            durationMs: 8,
            sources: ['project'],
            hookType: 'decision',
            toolName: 'Bash',
          },
        ],
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'timeline-hooks-node',
          type: 'turn_timeline',
          content: '',
          timestamp: 500,
          turnTimeline: hookTimeline,
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('Hooks');
    expect(html).toContain('2 次触发');
    expect(html).toContain('命中 2 个 hook');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('UserPromptSubmit');
    expect(html).not.toContain('PreToolUse');
    expect(html).not.toContain('prompt hook passed');
    expect(html).not.toContain('Bash');
  });

  it('renders skill activity timeline nodes without source labels', () => {
    const skillTimeline: TurnTimelineNode = {
      id: 'timeline-skill',
      kind: 'skill_activity',
      timestamp: 520,
      tone: 'success',
      skillActivity: {
        summary: 'Skill 触发 1',
        items: [
          {
            timestamp: 521,
            skillId: 'lark-doc',
            label: 'lark-doc',
            action: 'triggered',
            detail: 'inline skill tool',
            source: 'debug-skill-source',
          },
        ],
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'timeline-skill-node',
          type: 'turn_timeline',
          content: '',
          timestamp: 520,
          turnTimeline: skillTimeline,
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('Skills');
    expect(html).toContain('lark-doc');
    expect(html).toContain('已触发');
    expect(html).not.toContain('debug-skill-source');
  });
});
