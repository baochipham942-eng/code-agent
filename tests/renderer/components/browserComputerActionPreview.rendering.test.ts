import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { ToolCall } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      processingSessionIds: new Set<string>(),
      openPreview: vi.fn(),
      workingDirectory: '/repo/app',
    }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      currentSessionId: 'session-1',
    }),
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'tool-1',
    name: 'browser_action',
    arguments: {},
    result: {
      toolCallId: 'tool-1',
      success: true,
      output: 'ok',
    },
    ...overrides,
  };
}

describe('browser/computer action preview rendering', () => {
  it('renders browser action preview with trace metadata', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallDisplay, {
        toolCall: makeToolCall({
          arguments: {
            action: 'click',
            selector: '#submit',
          },
          result: {
            toolCallId: 'tool-1',
            success: true,
            output: 'Clicked element: #submit',
            metadata: {
              traceId: 'trace-browser-click',
              workbenchTrace: {
                mode: 'headless',
              },
            },
          },
        }),
        index: 0,
        total: 1,
      }),
    );

    expect(html).toContain('Action');
    expect(html).toContain('点击页面元素');
    expect(html).toContain('#submit');
    expect(html).toContain('托管浏览器动作');
    expect(html).toContain('headless');
    expect(html).toContain('trace-browser-click');
  });

  it('renders desktop input preview without exposing typed text', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallDisplay, {
        toolCall: makeToolCall({
          name: 'computer_use',
          arguments: {
            action: 'type',
            text: 'secret@example.com',
            targetApp: 'Google Chrome',
          },
          result: {
            toolCallId: 'tool-1',
            success: true,
            output: 'Typed',
            metadata: {
              workbenchTrace: {
                id: 'trace-computer-type',
                mode: 'foreground_fallback',
              },
            },
          },
        }),
        index: 0,
        total: 1,
      }),
    );

    expect(html).toContain('桌面输入 18 chars');
    expect(html).toContain('Google Chrome');
    expect(html).toContain('桌面输入');
    expect(html).toContain('foreground_fallback');
    expect(html).toContain('trace-computer-type');
    expect(html).not.toContain('secret@example.com');
  });

  it('renders browser-scoped computer_use through the managed browser catalog path', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallDisplay, {
        toolCall: makeToolCall({
          name: 'computer_use',
          arguments: {
            action: 'smart_type',
            selector: '#email',
            text: 'secret@example.com',
          },
          result: {
            toolCallId: 'tool-1',
            success: true,
            output: 'Typed into #email',
            metadata: {
              workbenchTrace: {
                id: 'trace-browser-scoped-smart-type',
                mode: 'headless',
              },
            },
          },
        }),
        index: 0,
        total: 1,
      }),
    );

    expect(html).toContain('智能输入 18 chars');
    expect(html).toContain('#email');
    expect(html).toContain('托管浏览器动作');
    expect(html).toContain('trace-browser-scoped-smart-type');
    expect(html).not.toContain('前台需确认');
    expect(html).not.toContain('secret@example.com');
  });

  it('redacts browser typed text from collapsed result summary markup', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallDisplay, {
        toolCall: makeToolCall({
          name: 'browser_action',
          arguments: {
            action: 'type',
            selector: '#email',
            text: 'secret@example.com',
          },
          result: {
            toolCallId: 'tool-1',
            success: true,
            output: 'Typed "secret@example.com" into #email',
            metadata: {
              workbenchTrace: {
                id: 'trace-browser-type',
                mode: 'headless',
              },
            },
          },
        }),
        index: 0,
        total: 1,
      }),
    );

    expect(html).toContain('输入 18 chars');
    expect(html).toContain('#email');
    expect(html).toContain('trace-browser-type');
    expect(html).not.toContain('secret@example.com');
  });

  it('redacts browser typed text from auto-expanded error details', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallDisplay, {
        toolCall: makeToolCall({
          name: 'browser_action',
          arguments: {
            action: 'type',
            selector: '#email',
            text: 'secret@example.com',
          },
          result: {
            toolCallId: 'tool-1',
            success: false,
            error: 'Type failed after secret@example.com',
            metadata: {
              workbenchTrace: {
                id: 'trace-browser-type-error',
                mode: 'headless',
              },
            },
          },
        }),
        index: 0,
        total: 1,
      }),
    );

    expect(html).toContain('[redacted 18 chars]');
    expect(html).toContain('输入 18 chars');
    expect(html).toContain('failed');
    expect(html).toContain('trace-browser-type-error');
    expect(html).not.toContain('secret@example.com');
  });

  it('keeps Write file names next to the tool label instead of pushing them to the row edge', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallDisplay, {
        toolCall: makeToolCall({
          name: 'Write',
          arguments: {
            path: 'docs/source-ai-agent-evolution.md',
            content: '# AI Agent',
          },
          result: {
            toolCallId: 'tool-1',
            success: true,
            output: 'Created file: docs/source-ai-agent-evolution.md',
          },
        }),
        index: 0,
        total: 1,
      }),
    );

    expect(html).toContain('Write');
    expect(html).toContain('source-ai-agent-evolution.md');
    expect(html).not.toContain('ml-auto');
  });

  it('preserves metadata when grouped trace nodes are rebuilt into ToolCallDisplay props', () => {
    const nodes: TraceNode[] = [
      {
        id: 'node-browser-click',
        type: 'tool_call',
        content: '',
        timestamp: 1,
        toolCall: {
          id: 'tool-1',
          name: 'browser_action',
          args: {
            action: 'click',
            selector: '#phase3-workflow-button',
          },
          result: 'Clicked element: #phase3-workflow-button',
          success: true,
          metadata: {
            traceId: 'trace-grouped-click',
            workbenchTrace: {
              mode: 'headless',
            },
          },
        },
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(ToolStepGroup, {
        nodes,
        defaultExpanded: true,
      }),
    );

    expect(html).toContain('Browser click');
    expect(html).toContain('点击页面元素');
    expect(html).toContain('#phase3-workflow-button');
    expect(html).toContain('trace-grouped-click');
  });

  it('expands failed browser-scoped computer groups with recovery details', () => {
    const nodes: TraceNode[] = [
      {
        id: 'node-computer-failure',
        type: 'tool_call',
        content: '',
        timestamp: 1,
        toolCall: {
          id: 'tool-computer-failure',
          name: 'computer_use',
          args: {
            action: 'smart_type',
            selector: '#missing-email',
            text: 'app-host-secret@example.com',
          },
          result: 'No element found after trying app-host-secret@example.com',
          success: false,
          metadata: {
            traceId: 'trace-computer-failure',
            computerSurfaceMode: 'foreground_fallback',
          },
        },
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(ToolStepGroup, {
        nodes,
      }),
    );

    expect(html).toContain('Computer');
    expect(html).toContain('刷新页面证据');
    expect(html).toContain('读取 DOM / Accessibility snapshot');
    expect(html).toContain('trace-computer-failure');
    expect(html).toContain('[redacted 27 chars]');
    expect(html).not.toContain('app-host-secret@example.com');
  });

  it('redacts failed computer tool result from turn header tooltip markup', () => {
    const html = renderToStaticMarkup(
      React.createElement(TurnCard, {
        defaultExpanded: true,
        turn: {
          turnNumber: 1,
          turnId: 'turn-computer-failure',
          status: 'completed',
          startTime: 1,
          endTime: 2,
          nodes: [
            {
              id: 'user-1',
              type: 'user',
              content: 'Trigger failure',
              timestamp: 1,
            },
            {
              id: 'node-computer-failure',
              type: 'tool_call',
              content: '',
              timestamp: 2,
              toolCall: {
                id: 'tool-computer-failure',
                name: 'computer_use',
                args: {
                  action: 'smart_type',
                  selector: '#missing-email',
                  text: 'app-host-secret@example.com',
                },
                result: 'No element found after trying app-host-secret@example.com',
                success: false,
                metadata: {
                  traceId: 'trace-computer-failure',
                },
              },
            },
          ],
        },
      }),
    );

    expect(html).toContain('[redacted 27 chars]');
    expect(html).not.toContain('app-host-secret@example.com');
  });

  it('marks mixed tool groups as partial instead of a full failure', () => {
    const nodes: TraceNode[] = [
      {
        id: 'node-search',
        type: 'tool_call',
        content: '',
        timestamp: 1,
        toolCall: {
          id: 'tool-search',
          name: 'WebSearch',
          args: { query: 'pawwork github' },
          result: '8 results',
          success: true,
        },
      },
      {
        id: 'node-fetch',
        type: 'tool_call',
        content: '',
        timestamp: 2,
        toolCall: {
          id: 'tool-fetch',
          name: 'WebFetch',
          args: { url: 'https://github.com/pawwork' },
          result: 'HTTP 404 Not Found',
          success: false,
        },
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(ToolStepGroup, {
        nodes,
        defaultExpanded: false,
      }),
    );

    expect(html).toContain('aria-label="部分失败"');
    expect(html).not.toContain('aria-label="失败"');
  });
});
