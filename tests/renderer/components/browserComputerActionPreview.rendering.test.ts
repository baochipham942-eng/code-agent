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
});
