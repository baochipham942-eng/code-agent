import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { SwarmLaunchRequest } from '../../../src/shared/contract/swarm';
import type { TurnTimelineNode } from '../../../src/shared/contract/turnTimeline';

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
            message: 'prompt hook passed',
          },
          {
            timestamp: 502,
            event: 'PreToolUse',
            action: 'allow',
            hookCount: 1,
            durationMs: 8,
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
