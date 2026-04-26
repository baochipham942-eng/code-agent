import { describe, expect, it } from 'vitest';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import {
  sanitizeToolCallsForHistory,
  sanitizeToolResultsForHistoryWithCalls,
} from '../../../src/main/agent/messageHandling/converter';

const SECRET = 'secret@example.com';

describe('Browser/Computer history redaction', () => {
  it('redacts Browser/Computer tool arguments before session history persistence', () => {
    const toolCalls: ToolCall[] = [{
      id: 'tool-1',
      name: 'computer_use',
      arguments: {
        action: 'smart_type',
        selector: '#email',
        text: SECRET,
      },
    }];

    const sanitized = sanitizeToolCallsForHistory(toolCalls) || [];
    const json = JSON.stringify(sanitized);

    expect(json).toContain('[redacted 18 chars]');
    expect(json).toContain('#email');
    expect(json).not.toContain(SECRET);
  });

  it('redacts Browser/Computer results and drops raw DOM/AX metadata before session history persistence', () => {
    const toolCalls: ToolCall[] = [{
      id: 'tool-1',
      name: 'browser_action',
      arguments: {
        action: 'fill_form',
        text: SECRET,
        formData: {
          '#email': SECRET,
        },
      },
    }];
    const toolResults: ToolResult[] = [{
      toolCallId: 'tool-1',
      success: false,
      error: `Fill failed after ${SECRET}`,
      metadata: {
        domSnapshot: {
          rawHtml: `<input value="${SECRET}">`,
        },
        accessibilitySnapshot: {
          role: 'textbox',
          name: SECRET,
        },
        workbenchTrace: {
          id: 'trace-1',
          targetKind: 'browser',
          toolName: 'browser_action',
          action: 'fill_form',
          mode: 'headless',
          startedAtMs: 1,
          before: {
            url: 'https://example.test/account?token=abc',
            title: 'Account',
          },
          params: {
            action: 'fill_form',
            formData: {
              '#email': SECRET,
            },
          },
          success: false,
          error: `Fill failed after ${SECRET}`,
        },
        browserComputerRecoveryActionOutcome: {
          status: 'success',
          title: '页面证据已刷新',
          evidence: [`Active tab: ${SECRET}`],
          retryHint: `Manual retry after ${SECRET}`,
        },
      },
    }];

    const sanitized = sanitizeToolResultsForHistoryWithCalls(toolResults, toolCalls);
    const json = JSON.stringify(sanitized);

    expect(json).toContain('[redacted 18 chars]');
    expect(json).toContain('页面证据已刷新');
    expect(json).toContain('https://example.test/account');
    expect(json).not.toContain('token=abc');
    expect(json).not.toContain('domSnapshot');
    expect(json).not.toContain('accessibilitySnapshot');
    expect(json).not.toContain('rawHtml');
    expect(json).not.toContain(SECRET);
  });

  it('redacts typed Computer Use failure taxonomy metadata before persistence', () => {
    const typedSecret = 'typed-password-123';
    const toolCalls: ToolCall[] = [{
      id: 'tool-1',
      name: 'computer_use',
      arguments: {
        action: 'type',
        targetApp: 'Notes',
        axPath: '1.2',
        text: typedSecret,
      },
    }];
    const toolResults: ToolResult[] = [{
      toolCallId: 'tool-1',
      success: false,
      error: `Background action failed while typing ${typedSecret}`,
      metadata: {
        failureKind: 'action_execution_failed',
        blockingReasons: [
          `The target rejected typed text ${typedSecret}`,
        ],
        recommendedAction: `Retry after clearing the field that contains ${typedSecret}`,
        workbenchTrace: {
          id: 'trace-1',
          targetKind: 'computer',
          toolName: 'computer_use',
          action: 'type',
          mode: 'background_ax',
          startedAtMs: 1,
          params: {
            action: 'type',
            targetApp: 'Notes',
            axPath: '1.2',
            text: typedSecret,
          },
          failureKind: 'action_execution_failed',
          blockingReasons: [
            `The target rejected typed text ${typedSecret}`,
          ],
          recommendedAction: `Retry after clearing the field that contains ${typedSecret}`,
          success: false,
          error: `Background action failed while typing ${typedSecret}`,
        },
      },
    }];

    const sanitized = sanitizeToolResultsForHistoryWithCalls(toolResults, toolCalls);
    const json = JSON.stringify(sanitized);

    expect(json).toContain('action_execution_failed');
    expect(json).toContain('[redacted 18 chars]');
    expect(json).not.toContain(typedSecret);
    expect(json).not.toContain('typed-password');
  });

  it('summarizes managed browser profile and artifact paths before persistence', () => {
    const toolCalls: ToolCall[] = [{
      id: 'tool-1',
      name: 'browser_action',
      arguments: {
        action: 'get_workbench_state',
      },
    }];
    const toolResults: ToolResult[] = [{
      toolCallId: 'tool-1',
      success: true,
      output: 'Browser workbench state',
      metadata: {
        browserWorkbenchState: {
          sessionId: 'browser_session_1',
          profileId: 'managed-browser-profile',
          profileMode: 'persistent',
          profileDir: '/Users/linchen/Library/Application Support/code-agent/managed-browser-profile',
          artifactDir: '/Users/linchen/Downloads/ai/code-agent/.workbench/artifacts/run-42',
          workspaceScope: '/Users/linchen/Downloads/ai/code-agent',
          cookie: {
            name: 'session',
            value: 'cookie-secret',
          },
          storageState: {
            cookies: [{ name: 'sid', value: 'cookie-secret' }],
          },
        },
        workbenchTrace: {
          id: 'trace-profile',
          targetKind: 'browser',
          toolName: 'browser_action',
          action: 'get_workbench_state',
          mode: 'headless',
          startedAtMs: 1,
          profileDir: '/Users/linchen/Library/Application Support/code-agent/managed-browser-profile',
        },
      },
    }];

    const sanitized = sanitizeToolResultsForHistoryWithCalls(toolResults, toolCalls);
    const json = JSON.stringify(sanitized);

    expect(json).toContain('browser_session_1');
    expect(json).toContain('managed-browser-profile');
    expect(json).toContain('.../run-42');
    expect(json).toContain('.../code-agent');
    expect(json).not.toContain('/Users/linchen');
    expect(json).not.toContain('cookie-secret');
    expect(json).not.toContain('storageState');
    expect(json).not.toContain('profileDir');
  });
});
