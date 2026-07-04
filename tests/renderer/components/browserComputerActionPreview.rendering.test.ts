import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { ToolCall } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/stores/appStore', () => {
  // useI18n 不带 selector 直接解构整个 store（language/setLanguage/cloudUIStrings），
  // 其余调用方都走 selector 形式——mock 必须两种调用方式都支持。
  const state = {
    processingSessionIds: new Set<string>(),
    openPreview: vi.fn(),
    workingDirectory: '/repo/app',
    language: 'zh' as const,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  };
  return {
    useAppStore: (selector?: (state: typeof state) => unknown) =>
      (selector ? selector(state) : state),
  };
});

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
  it('renders browser action preview without exposing trace metadata in the main row', () => {
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
    expect(html).not.toContain('headless');
    expect(html).not.toContain('trace-browser-click');
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
    expect(html).not.toContain('foreground_fallback');
    expect(html).not.toContain('trace-computer-type');
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
    expect(html).not.toContain('trace-browser-scoped-smart-type');
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
    expect(html).not.toContain('trace-browser-type');
    expect(html).not.toContain('secret@example.com');
  });

  it('redacts browser typed text from the default-collapsed error row summary', () => {
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

    // 工具行默认折叠：错误回合不再自动展开详情。脱敏仍成立——折叠态只显示已脱敏的
    // 动作摘要（"输入 18 chars"）+ 红边框 + hover 摘要，原始输入文本绝不出现。
    expect(html).toContain('输入 18 chars');
    expect(html).toContain('failed');
    expect(html).not.toContain('trace-browser-type-error');
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

  it('hides source and raw status jargon from tool meta rows', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallDisplay, {
        toolCall: makeToolCall({
          name: 'Write',
          arguments: {
            path: 'index.html',
            content: '<!doctype html>',
          },
          result: undefined,
        }),
        index: 0,
        total: 1,
      }),
    );

    expect(html).toContain('会改文件');
    expect(html).not.toContain('builtin');
    expect(html).not.toContain('running');
    expect(html).not.toContain('等待结果');
  });

  it('renders workflow subagent stages from result metadata', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallDisplay, {
        toolCall: makeToolCall({
          name: 'workflow_orchestrate',
          arguments: {
            workflow: 'custom',
          },
          result: {
            toolCallId: 'tool-1',
            success: true,
            output: 'Workflow complete',
            metadata: {
              completedStages: 1,
              failedStages: 0,
              stages: [
                {
                  name: 'reviewer',
                  role: 'reviewer',
                  success: true,
                  duration: 27508,
                  toolsUsed: ['Grep', 'Glob', 'Read'],
                  toolPolicy: {
                    mode: 'readonly',
                  },
                },
              ],
            },
          },
        }),
        index: 0,
        total: 1,
      }),
    );

    expect(html).not.toContain('派出 1 个子智能体');
    expect(html).toContain('reviewer');
    expect(html).toContain('readonly');
    expect(html).toContain('Grep, Glob, Read');
    expect(html).toContain('27.5s');
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

    expect(html).toContain('浏览器 click');
    expect(html).toContain('点击页面元素');
    expect(html).toContain('#phase3-workflow-button');
    expect(html).toContain('trace-grouped-click');
  });

  it('探索性失败的浏览器/电脑操作组（未分类错误）默认折叠，原始敏感文本不泄漏', () => {
    // 产品拍板：探索性失败（这里是"没找到元素"，未被 humanizeToolError 分类，非
    // 鉴权/额度/限流）一律默认折叠成一行，不再强制整组展开。
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

    const collapsedHtml = renderToStaticMarkup(
      React.createElement(ToolStepGroup, { nodes }),
    );
    expect(collapsedHtml).toContain('aria-expanded="false"');
    expect(collapsedHtml).not.toContain('app-host-secret@example.com');

    // 折叠不等于信息丢失：展开后仍能看到脱敏摘要"智能输入 27 chars"，原始邮箱地址依旧不泄漏。
    const expandedHtml = renderToStaticMarkup(
      React.createElement(ToolStepGroup, { nodes, defaultExpanded: true }),
    );
    expect(expandedHtml).toContain('Computer');
    expect(expandedHtml).toContain('trace-computer-failure');
    expect(expandedHtml).toContain('智能输入 27 chars');
    expect(expandedHtml).not.toContain('app-host-secret@example.com');
  });

  it('redacts failed computer tool result from turn header tooltip markup', () => {
    // 探索性失败（未分类错误）现在默认折叠成一行：回合层面渲染时原始敏感文本
    // 绝不出现在 DOM 里（既不在折叠态也不在任何 tooltip/title 属性上）。
    const turn = {
      turnNumber: 1,
      turnId: 'turn-computer-failure',
      status: 'completed' as const,
      startTime: 1,
      endTime: 2,
      nodes: [
        {
          id: 'user-1',
          type: 'user' as const,
          content: 'Trigger failure',
          timestamp: 1,
        },
        {
          id: 'node-computer-failure',
          type: 'tool_call' as const,
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
    };

    const collapsedHtml = renderToStaticMarkup(
      React.createElement(TurnCard, { defaultExpanded: true, turn }),
    );
    expect(collapsedHtml).not.toContain('app-host-secret@example.com');

    // 折叠不等于信息丢失：点开工具组后依旧只看到脱敏摘要"智能输入 27 chars"，不是原文。
    const expandedGroupHtml = renderToStaticMarkup(
      React.createElement(ToolStepGroup, { nodes: [turn.nodes[1]], defaultExpanded: true }),
    );
    expect(expandedGroupHtml).toContain('智能输入 27 chars');
    expect(expandedGroupHtml).not.toContain('app-host-secret@example.com');
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

  it('summarizes partial file lookup groups without treating read evidence as output', () => {
    const nodes: TraceNode[] = [
      {
        id: 'node-read-missing',
        type: 'tool_call',
        content: '',
        timestamp: 1,
        toolCall: {
          id: 'tool-read-missing',
          name: 'Read',
          args: { file_path: '/Users/linchen/.code-agent/memory/shared/openclaw.md' },
          result: 'File not found: /Users/linchen/.code-agent/memory/shared/openclaw.md',
          success: false,
        },
      },
      {
        id: 'node-grep-empty',
        type: 'tool_call',
        content: '',
        timestamp: 2,
        toolCall: {
          id: 'tool-grep-empty',
          name: 'Grep',
          args: { pattern: 'openclaw' },
          result: 'No matches found',
          success: true,
        },
      },
      {
        id: 'node-glob-empty',
        type: 'tool_call',
        content: '',
        timestamp: 3,
        toolCall: {
          id: 'tool-glob-empty',
          name: 'Glob',
          args: { pattern: '**/openclaw*' },
          result: 'No files matched the pattern',
          success: true,
        },
      },
      {
        id: 'node-read-found',
        type: 'tool_call',
        content: '',
        timestamp: 4,
        toolCall: {
          id: 'tool-read-found',
          name: 'Read',
          args: { file_path: '/Users/linchen/.claude/projects/-Users-linchen/memory/openclaw.md' },
          result: '<artifact-repair-file-read-preview>\nTarget file read: /Users/linchen/.claude/projects/-Users-linchen/memory/openclaw.md\nOutput omitted from event stream (535 lines, 31230 chars).\n</artifact-repair-file-read-preview>',
          success: true,
          metadata: {
            filePath: '/Users/linchen/.claude/projects/-Users-linchen/memory/openclaw.md',
            artifactRepairPreview: true,
          },
        },
      },
    ];

    // 组头摘要（"1 failed, 2 empty, 1 completed"）在组头按钮里，折叠/展开态都可见。
    // "File not found" 是未分类的探索性失败，产品拍板后默认折叠成一行，逐条文件路径
    // 明细移到点开之后——折叠不等于信息丢失，只是不再强制摊开。
    const collapsedHtml = renderToStaticMarkup(
      React.createElement(ToolStepGroup, { nodes, defaultExpanded: false }),
    );
    expect(collapsedHtml).toContain('1 failed, 2 empty, 1 completed');
    expect(collapsedHtml).not.toContain('4/4 results');
    expect(collapsedHtml).not.toContain('1 output');
    expect(collapsedHtml).not.toContain('/Users/linchen/.claude/projects/-Users-linchen/memory/openclaw.md');

    const expandedHtml = renderToStaticMarkup(
      React.createElement(ToolStepGroup, { nodes, defaultExpanded: true }),
    );
    expect(expandedHtml).toContain('/Users/linchen/.claude/projects/-Users-linchen/memory/openclaw.md');
  });

  it('labels empty grep and glob results as no matches in collapsed details', () => {
    const grepHtml = renderToStaticMarkup(
      React.createElement(ToolCallDisplay, {
        toolCall: makeToolCall({
          id: 'tool-grep-empty',
          name: 'Grep',
          arguments: { pattern: 'openclaw' },
          result: {
            toolCallId: 'tool-grep-empty',
            success: true,
            output: 'No matches found',
          },
        }),
        index: 0,
        total: 1,
      }),
    );
    const globHtml = renderToStaticMarkup(
      React.createElement(ToolCallDisplay, {
        toolCall: makeToolCall({
          id: 'tool-glob-empty',
          name: 'Glob',
          arguments: { pattern: '**/openclaw*' },
          result: {
            toolCallId: 'tool-glob-empty',
            success: true,
            output: 'No files matched the pattern',
          },
        }),
        index: 0,
        total: 1,
      }),
    );

    expect(grepHtml).toContain('No matches');
    expect(grepHtml).not.toContain('Found 1 result');
    expect(globHtml).toContain('No matches');
    expect(globHtml).not.toContain('Found 1 file');
  });
});
