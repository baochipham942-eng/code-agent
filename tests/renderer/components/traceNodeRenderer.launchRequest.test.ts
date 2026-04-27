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
    expect(html).toContain('Scope Inspector Lite');
    expect(html).toContain('User Selected');
    expect(html).toContain('Runtime Blocked');
    expect(html).toContain('Actually Invoked');
    expect(html).toContain('skill_not_mounted');
    expect(html).toContain('Mail');
    expect(html).toContain('send');
    expect(html).toContain('本轮输出');
    expect(html).toContain('report.md');
  });
});
