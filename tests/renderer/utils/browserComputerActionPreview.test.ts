import { describe, expect, it } from 'vitest';
import {
  buildBrowserComputerActionPreview,
  formatBrowserComputerActionArguments,
  formatBrowserComputerActionResultDetails,
  summarizeBrowserComputerActionResult,
} from '../../../src/renderer/utils/browserComputerActionPreview';
import type { ToolCall } from '../../../src/shared/contract';

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'tool-1',
    name: 'browser_action',
    arguments: {},
    ...overrides,
  };
}

describe('buildBrowserComputerActionPreview', () => {
  it('summarizes browser navigation with trace metadata', () => {
    const preview = buildBrowserComputerActionPreview(makeToolCall({
      name: 'browser_action',
      arguments: {
        action: 'navigate',
        url: 'https://example.com/docs/start?utm=1',
      },
      result: {
        toolCallId: 'tool-1',
        success: true,
        output: 'ok',
        metadata: {
          traceId: 'trace-browser-1',
          workbenchTrace: {
            mode: 'headless',
          },
        },
      },
    }));

    expect(preview).toMatchObject({
      surface: 'browser',
      summary: '导航到页面',
      target: 'example.com/docs/start',
      risk: 'browser_action',
      riskLabel: '托管浏览器动作',
      traceId: 'trace-browser-1',
      mode: 'headless',
    });
  });

  it('keeps browser snapshots marked as read-only', () => {
    expect(buildBrowserComputerActionPreview(makeToolCall({
      name: 'browser_action',
      arguments: {
        action: 'get_dom_snapshot',
      },
    }))).toMatchObject({
      surface: 'browser',
      summary: '读取 DOM snapshot',
      risk: 'read',
      riskLabel: '只读',
    });
  });

  it('redacts typed desktop text to a length-only preview', () => {
    expect(buildBrowserComputerActionPreview(makeToolCall({
      name: 'computer_use',
      arguments: {
        action: 'type',
        text: 'secret@example.com',
        targetApp: 'Google Chrome',
      },
      result: {
        toolCallId: 'tool-1',
        success: true,
        output: 'ok',
        metadata: {
          workbenchTrace: {
            id: 'trace-computer-1',
            mode: 'foreground_fallback',
          },
        },
      },
    }))).toMatchObject({
      surface: 'computer',
      summary: '桌面输入 18 chars',
      target: 'Google Chrome',
      risk: 'desktop_input',
      riskLabel: '桌面输入',
      traceId: 'trace-computer-1',
      mode: 'foreground_fallback',
    });
  });

  it('summarizes read-only computer observation', () => {
    expect(buildBrowserComputerActionPreview(makeToolCall({
      name: 'computer_use',
      arguments: {
        action: 'observe',
        includeScreenshot: true,
      },
    }))).toMatchObject({
      surface: 'computer',
      summary: '观察前台窗口',
      target: 'with screenshot',
      risk: 'read',
    });
  });

  it('uses Computer Surface metadata as the desktop target fallback', () => {
    expect(buildBrowserComputerActionPreview(makeToolCall({
      name: 'computer_use',
      arguments: {
        action: 'click',
      },
      result: {
        toolCallId: 'tool-1',
        success: false,
        error: 'blocked',
        metadata: {
          targetApp: 'Safari',
          foregroundFallback: true,
          workbenchTrace: {
            id: 'trace-computer-2',
            mode: 'foreground_fallback',
          },
        },
      },
    }))).toMatchObject({
      surface: 'computer',
      summary: 'click 坐标',
      target: 'Safari',
      mode: 'foreground_fallback',
    });
  });

  it('labels background Accessibility element actions distinctly from coordinate clicks', () => {
    expect(buildBrowserComputerActionPreview(makeToolCall({
      name: 'computer_use',
      arguments: {
        action: 'click',
        targetApp: 'Finder',
        role: 'button',
        name: 'Back',
      },
      result: {
        toolCallId: 'tool-1',
        success: true,
        output: 'Background click completed',
        metadata: {
          targetApp: 'Finder',
          backgroundSurface: true,
          workbenchTrace: {
            id: 'trace-computer-bg',
            mode: 'background_ax',
          },
        },
      },
    }))).toMatchObject({
      surface: 'computer',
      summary: 'click 后台元素',
      target: 'button "Back"',
      mode: 'background_ax',
    });
  });

  it('uses axPath as the background Accessibility target when provided', () => {
    expect(buildBrowserComputerActionPreview(makeToolCall({
      name: 'computer_use',
      arguments: {
        action: 'click',
        targetApp: 'Finder',
        axPath: '1.2.3',
      },
      result: {
        toolCallId: 'tool-1',
        success: true,
        output: 'Background click completed',
        metadata: {
          targetApp: 'Finder',
          backgroundSurface: true,
          targetAxPath: '1.2.3',
          workbenchTrace: {
            id: 'trace-computer-bg-path',
            mode: 'background_ax',
          },
        },
      },
    }))).toMatchObject({
      surface: 'computer',
      summary: 'click 后台元素',
      target: 'axPath 1.2.3',
      mode: 'background_ax',
    });
  });

  it('summarizes background Accessibility element listing as read-only', () => {
    const toolCall = makeToolCall({
      name: 'computer_use',
      arguments: {
        action: 'get_ax_elements',
        targetApp: 'Finder',
      },
      result: {
        toolCallId: 'tool-1',
        success: true,
        output: 'Found 2 background AX elements for Finder:\n1. AXButton "Back" [axPath=1.1]\n2. AXTextField "Search" [axPath=1.2]',
        metadata: {
          targetApp: 'Finder',
          elements: [
            { index: 1, role: 'AXButton', name: 'Back', axPath: '1.1' },
            { index: 2, role: 'AXTextField', name: 'Search', axPath: '1.2' },
          ],
          workbenchTrace: {
            id: 'trace-computer-ax-list',
            mode: 'background_ax',
          },
        },
      },
    });

    expect(buildBrowserComputerActionPreview(toolCall)).toMatchObject({
      surface: 'computer',
      summary: '读取后台 AX 元素',
      target: 'Finder',
      risk: 'read',
      riskLabel: '只读',
      mode: 'background_ax',
    });
    expect(summarizeBrowserComputerActionResult(toolCall)).toBe('2 background AX elements');
  });

  it('redacts browser typed text from collapsed result summaries', () => {
    const summary = summarizeBrowserComputerActionResult(makeToolCall({
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
      },
    }));

    expect(summary).toBe('输入 18 chars -> #email');
    expect(summary).not.toContain('secret@example.com');
  });

  it('redacts browser typed text from expanded arguments and error details', () => {
    const toolCall = makeToolCall({
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
      },
    });

    const args = formatBrowserComputerActionArguments(toolCall.name, toolCall.arguments || {});
    const result = formatBrowserComputerActionResultDetails(toolCall);

    expect(args).toContain('[redacted 18 chars]');
    expect(args).not.toContain('secret@example.com');
    expect(result).toBe('输入 18 chars -> #email failed');
    expect(result).not.toContain('secret@example.com');
  });

  it('redacts browser form values from expanded arguments', () => {
    const args = formatBrowserComputerActionArguments('browser_action', {
      action: 'fill_form',
      formData: {
        '#email': 'secret@example.com',
        '#otp': '123456',
      },
    });

    expect(args).toContain('[redacted 18 chars]');
    expect(args).toContain('[redacted 6 chars]');
    expect(args).not.toContain('secret@example.com');
    expect(args).not.toContain('123456');
  });

  it('redacts smart typed text from collapsed result summaries', () => {
    const summary = summarizeBrowserComputerActionResult(makeToolCall({
      name: 'computer_use',
      arguments: {
        action: 'smart_type',
        selector: '#email',
        text: 'secret@example.com',
      },
      result: {
        toolCallId: 'tool-1',
        success: true,
        output: 'Typed into #email: "secret@example.com"',
      },
    }));

    expect(summary).toBe('智能输入 18 chars -> #email');
    expect(summary).not.toContain('secret@example.com');
  });

  it('summarizes browser snapshots without dumping raw content', () => {
    expect(summarizeBrowserComputerActionResult(makeToolCall({
      name: 'browser_action',
      arguments: {
        action: 'get_dom_snapshot',
      },
      result: {
        toolCallId: 'tool-1',
        success: true,
        output: JSON.stringify({ headings: ['Title'], interactive: [{ tag: 'button' }] }),
        metadata: {
          domSnapshot: {
            headings: ['Title'],
            interactive: [{ tag: 'button' }],
          },
        },
      },
    }))).toBe('DOM snapshot: 1 headings · 1 interactive');
  });

  it('ignores unrelated tools', () => {
    expect(buildBrowserComputerActionPreview(makeToolCall({
      name: 'Bash',
      arguments: {
        command: 'npm test',
      },
    }))).toBeNull();
  });
});
