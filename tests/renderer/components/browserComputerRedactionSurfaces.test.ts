import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatObservableArguments,
  formatObservableResult,
  getObservableToolSummary,
  type ObservableEvent,
} from '../../../src/renderer/components/ObservabilityPanel';
import {
  ReplayMessageBlock,
  formatArgsDetails,
  formatResultDetails,
  type ToolCallData,
} from '../../../src/renderer/components/features/evalCenter/ReplayMessageBlock';
import {
  exportToJson,
  exportToMarkdown,
} from '../../../src/renderer/components/features/export/ExportModal';
import { sanitizeSessionForBrowserComputerExport } from '../../../src/renderer/utils/browserComputerExportRedaction';
import type { Message } from '../../../src/shared/contract';

const SECRET = 'secret@example.com';

describe('browser/computer redaction surfaces', () => {
  it('redacts Browser/Computer input payloads in observability details', () => {
    const event: ObservableEvent = {
      id: 'event-1',
      category: 'tools',
      name: 'browser_action',
      summary: 'browser_action',
      timestamp: 1,
      status: 'error',
      details: {
        arguments: {
          action: 'fill_form',
          text: SECRET,
          formData: {
            '#email': SECRET,
          },
        },
        result: {
          toolCallId: 'tool-1',
          success: false,
          error: `Fill form failed after ${SECRET}`,
        },
      },
    };

    const args = formatObservableArguments(event);
    const result = formatObservableResult(event) || '';

    expect(args).toContain('[redacted 18 chars]');
    expect(args).not.toContain(SECRET);
    expect(result).toContain('填写表单');
    expect(result).not.toContain(SECRET);
  });

  it('redacts Browser/Computer input payloads in replay details', () => {
    const toolCall: ToolCallData = {
      id: 'tool-1',
      name: 'computer_use',
      args: {
        action: 'smart_type',
        text: SECRET,
      },
      result: `No element found after trying ${SECRET}`,
      success: false,
      duration: 12,
      category: 'Other',
    };

    const args = formatArgsDetails(toolCall.name, toolCall.args);
    const result = formatResultDetails(toolCall) || '';

    expect(args).toContain('[redacted 18 chars]');
    expect(args).not.toContain(SECRET);
    expect(result).toContain('没执行成功');
    expect(result).toContain('目标元素');
    expect(result).not.toContain(SECRET);
  });

  it('redacts Browser/Computer input payloads in markdown and json exports', () => {
    const messages: Message[] = [{
      id: 'msg-1',
      role: 'assistant',
      content: 'Tool failure',
      timestamp: 1,
      toolCalls: [{
        id: 'tool-1',
        name: 'browser_action',
        arguments: {
          action: 'fill_form',
          text: SECRET,
          formData: {
            '#email': SECRET,
          },
        },
        result: {
          toolCallId: 'tool-1',
          success: false,
          error: `Fill form failed after ${SECRET}`,
          metadata: {
            attemptedValue: SECRET,
            domSnapshot: {
              html: `<input value="${SECRET}">`,
            },
            accessibilitySnapshot: {
              role: 'textbox',
              name: SECRET,
            },
            browserWorkbenchState: {
              sessionId: 'browser_session_1',
              profileId: 'managed-browser-profile',
              profileMode: 'persistent',
              profileDir: '/Users/linchen/Library/Application Support/code-agent/managed-browser-profile',
              artifactDir: '/Users/linchen/Downloads/ai/code-agent/.workbench/artifacts/run-42',
              workspaceScope: '/Users/linchen/Downloads/ai/code-agent',
              cookies: [{ name: 'sid', value: 'cookie-secret' }],
              storageState: { cookies: [{ name: 'sid', value: 'cookie-secret' }] },
            },
            browserComputerRecoveryActionOutcome: {
              status: 'success',
              title: '页面证据已刷新',
              evidence: [
                'DOM headings: 1',
                'Interactive elements: 2',
                'Accessibility snapshot: available',
                `Active tab: ${SECRET}`,
              ],
              retryHint: `Manual retry after ${SECRET}`,
            },
          },
        },
      }],
    }];

    const markdown = exportToMarkdown('Session', messages);
    const json = exportToJson('Session', messages);

    expect(markdown).toContain('[redacted 18 chars]');
    expect(markdown).toContain('页面证据已刷新');
    expect(markdown).toContain('DOM headings: 1');
    expect(markdown).toContain('Accessibility snapshot: available');
    expect(markdown).not.toContain(SECRET);
    expect(json).toContain('[redacted 18 chars]');
    expect(json).toContain('页面证据已刷新');
    expect(json).toContain('DOM headings: 1');
    expect(json).toContain('browser_session_1');
    expect(json).toContain('managed-browser-profile');
    expect(json).toContain('.../run-42');
    expect(json).not.toContain('domSnapshot');
    expect(json).not.toContain('accessibilitySnapshot');
    expect(json).not.toContain('/Users/linchen');
    expect(json).not.toContain('cookie-secret');
    expect(json).not.toContain('storageState');
    expect(json).not.toContain(SECRET);
  });

  it('redacts Browser/Computer payloads in raw session json export data', () => {
    const session = {
      id: 'session-1',
      messages: [{
        id: 'msg-1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{
          id: 'tool-1',
          name: 'computer_use',
          arguments: {
            action: 'smart_type',
            text: SECRET,
          },
          result: {
            toolCallId: 'tool-1',
            success: false,
            error: `No element found after ${SECRET}`,
          },
        }],
      } as Message],
    };

    const json = JSON.stringify(sanitizeSessionForBrowserComputerExport(session), null, 2);

    expect(json).toContain('[redacted 18 chars]');
    expect(json).toContain('没执行成功');
    expect(json).toContain('目标元素');
    expect(json).not.toContain(SECRET);
  });

  it('renders ReplayMessageBlock recovery evidence without exposing typed secrets', () => {
    const html = renderToStaticMarkup(React.createElement(ReplayMessageBlock, {
      block: {
        type: 'tool_call',
        content: 'computer_use',
        timestamp: 1,
        toolCall: {
          id: 'tool-1',
          name: 'computer_use',
          args: {
            action: 'smart_type',
            text: SECRET,
          },
          result: `No element found after ${SECRET}`,
          resultMetadata: {
            browserComputerRecoveryActionOutcome: {
              status: 'success',
              title: 'AX 候选已准备',
              evidence: [
                'Candidates: 2',
                'Target app: Google Chrome',
                `First candidates: text field "${SECRET}" (axPath 1.2.3)`,
              ],
              retryHint: `Manual retry after ${SECRET}`,
            },
          },
          success: false,
          duration: 12,
          category: 'Other',
        },
      },
    }));

    expect(html).toContain('AX 候选已准备');
    expect(html).toContain('Candidates: 2');
    expect(html).toContain('[redacted 18 chars]');
    expect(html).not.toContain(SECRET);
  });

  it('formats ObservabilityPanel recovery summaries without raw secrets or raw evidence payloads', () => {
    const event: ObservableEvent = {
      id: 'event-1',
      category: 'browserComputer',
      name: 'computer_use',
      summary: 'computer_use',
      timestamp: 1,
      status: 'error',
      details: {
        arguments: {
          action: 'smart_type',
          text: SECRET,
        },
        result: {
          toolCallId: 'tool-1',
          success: false,
          error: `No element found after ${SECRET}`,
          metadata: {
            rawAxTree: [{ name: SECRET }],
            browserComputerRecoveryActionOutcome: {
              status: 'success',
              title: '窗口证据已读取',
              evidence: [
                'App: Google Chrome',
                `Window: ${SECRET}`,
              ],
            },
          },
        },
      },
    };

    const result = formatObservableResult(event) || '';

    expect(result).toContain('窗口证据已读取');
    expect(result).toContain('App: Google Chrome');
    expect(result).not.toContain('Window:');
    expect(result).not.toContain('rawAxTree');
    expect(result).not.toContain(SECRET);
  });

  it('summarizes Browser/Computer observability rows without exposing typed input', () => {
    const summary = getObservableToolSummary({
      id: 'tool-1',
      name: 'computer_use',
      arguments: {
        action: 'smart_type',
        selector: '#email',
        text: SECRET,
      },
      result: {
        toolCallId: 'tool-1',
        success: false,
        error: `No element found after ${SECRET}`,
        metadata: {
          computerSurfaceMode: 'foreground_fallback',
        },
      },
    });

    expect(summary).toContain('智能输入 18 chars');
    expect(summary).toContain('#email');
    expect(summary).toContain('需确认');
    expect(summary).not.toContain(SECRET);
  });

  it('keeps open_desktop_status framed as no prepared evidence across surfaces', () => {
    const toolCall: ToolCallData = {
      id: 'tool-1',
      name: 'computer_use',
      args: {
        action: 'type',
        text: SECRET,
      },
      result: 'Desktop status opened',
      resultMetadata: {
        browserComputerRecoveryActionOutcome: {
          status: 'success',
          title: 'Desktop status 已打开',
          evidence: ['只打开了状态面板，没有准备新的 DOM、AX 或 Accessibility 证据。'],
          noEvidence: true,
        },
      },
      success: true,
      duration: 10,
      category: 'Other',
    };

    const result = formatResultDetails(toolCall) || '';

    expect(result).toContain('Desktop status 已打开');
    expect(result).toContain('只打开了状态面板');
    expect(result).toContain('没有准备新的 DOM、AX 或 Accessibility 证据');
    expect(result).not.toContain('页面证据已刷新');
    expect(result).not.toContain(SECRET);
  });

  it('redacts Browser/Computer replay headers when text is the first argument', () => {
    const toolCall: ToolCallData = {
      id: 'tool-1',
      name: 'computer_use',
      args: {
        text: SECRET,
        action: 'smart_type',
        selector: '#email',
      },
      result: `No element found after trying ${SECRET}`,
      success: false,
      duration: 12,
      category: 'Other',
    };

    const html = renderToStaticMarkup(React.createElement(ReplayMessageBlock, {
      block: {
        type: 'tool_call',
        content: 'computer_use',
        timestamp: 1,
        toolCall,
      },
    }));

    expect(html).toContain('智能输入 18 chars');
    expect(html).toContain('#email');
    expect(html).not.toContain(SECRET);
  });

  it('drops Browser/Computer raw metadata fields from exports', () => {
    const messages: Message[] = [{
      id: 'msg-1',
      role: 'assistant',
      content: 'Tool result',
      timestamp: 1,
      toolCalls: [{
        id: 'tool-1',
        name: 'computer_use',
        arguments: {
          action: 'get_ax_elements',
          targetApp: 'Safari',
        },
        result: {
          toolCallId: 'tool-1',
          success: true,
          output: 'Found 1 elements',
          metadata: {
            elements: [{ role: 'textbox', name: SECRET }],
            analysis: `Screenshot says ${SECRET}`,
            screenshotData: `data:image/png;base64,${SECRET}`,
            workbenchTrace: {
              id: 'trace-1',
              targetKind: 'computer',
              toolName: 'computer_use',
              action: 'get_ax_elements',
              startedAtMs: 1,
              success: true,
            },
          },
        },
      }],
    }];

    const json = exportToJson('Session', messages);
    const markdown = exportToMarkdown('Session', messages);

    expect(json).toContain('trace-1');
    expect(json).not.toContain('"elements"');
    expect(json).not.toContain('analysis');
    expect(json).not.toContain('screenshotData');
    expect(json).not.toContain(SECRET);
    expect(markdown).not.toContain(SECRET);
  });
});
