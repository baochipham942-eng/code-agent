// ============================================================================
// Browser Action Tool - Comprehensive browser automation with AI vision
// Available for all generations with tool calling capability
// Playwright-based browser control for testing and automation
// 支持智谱 GLM-4.6V-Flash 视觉分析
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { browserService } from '../../services/infra/browserService.js';
import { createLogger } from '../../services/infra/logger';
import { analyzeImageWithVision } from '../../services/desktop/visionAnalysisService';
import {
  appendBrowserWorkbenchNote,
  buildBrowserWorkbenchBlockedResult,
  ensureManagedBrowserSessionForWorkbench,
  evaluateBrowserWorkbenchPolicy,
} from './browserWorkbenchIntent';

const logger = createLogger('BrowserAction');

type BrowserActionType =
  | 'launch'
  | 'close'
  | 'new_tab'
  | 'close_tab'
  | 'list_tabs'
  | 'switch_tab'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'set_viewport'
  | 'click'
  | 'click_text'
  | 'type'
  | 'press_key'
  | 'scroll'
  | 'screenshot'
  | 'get_content'
  | 'get_elements'
  | 'get_dom_snapshot'
  | 'get_a11y_snapshot'
  | 'get_workbench_state'
  | 'wait'
  | 'fill_form'
  | 'get_logs';

const MANAGED_SESSION_ACTIONS = new Set<BrowserActionType>([
  'navigate',
  'back',
  'forward',
  'reload',
  'set_viewport',
  'click',
  'click_text',
  'type',
  'press_key',
  'scroll',
  'screenshot',
  'get_content',
  'get_elements',
  'get_dom_snapshot',
  'get_a11y_snapshot',
  'get_workbench_state',
  'wait',
  'fill_form',
]);

export const browserActionTool: Tool = {
  name: 'browser_action',
  description: `Control a browser for web automation and testing.

Use this tool to:
- Launch/close browser
- Navigate to URLs and interact with web pages
- Click elements, type text, fill forms
- Take screenshots for visual verification
- Read page content and find elements

Actions:
- launch: Start isolated managed browser (headless by default; set CODE_AGENT_BROWSER_VISIBLE=1 for visible debugging)
- close: Close browser
- new_tab: Open new tab (url optional)
- close_tab: Close a tab
- list_tabs: List all open tabs
- switch_tab: Switch to a specific tab
- navigate: Go to URL
- back/forward/reload: Navigation controls
- set_viewport: Switch the managed browser viewport
- click: Click element by selector
- click_text: Click element by text content
- type: Type text into element
- press_key: Press keyboard key (Enter, Tab, Escape, etc.)
- scroll: Scroll page (up/down)
- screenshot: Capture page screenshot (with optional AI analysis)
- get_content: Get page text and links
- get_elements: Find elements by selector
- get_dom_snapshot: Get structured headings and interactive elements
- get_a11y_snapshot: Get accessibility snapshot when available, with DOM fallback
- get_workbench_state: Return managed browser session/workbench state
- wait: Wait for element or timeout
- fill_form: Fill multiple form fields
- get_logs: Get recent browser operation logs (for debugging)

All operations return detailed logs for transparency.

Examples:
- {"action": "launch"}
- {"action": "new_tab", "url": "https://example.com"}
- {"action": "click", "selector": "button.submit"}
- {"action": "click_text", "text": "Sign In"}
- {"action": "type", "selector": "#search", "text": "hello"}
- {"action": "screenshot"}
- {"action": "screenshot", "analyze": true, "prompt": "描述页面内容"}
- {"action": "get_content"}`,
  requiresPermission: true,
  permissionLevel: 'execute',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'launch', 'close', 'new_tab', 'close_tab', 'list_tabs', 'switch_tab',
          'navigate', 'back', 'forward', 'reload', 'set_viewport',
          'click', 'click_text', 'type', 'press_key', 'scroll',
          'screenshot', 'get_content', 'get_elements', 'get_dom_snapshot', 'get_a11y_snapshot',
          'get_workbench_state', 'wait', 'fill_form', 'get_logs'
        ],
        description: 'The browser action to perform',
      },
      url: {
        type: 'string',
        description: 'URL for navigate/new_tab actions',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for element interactions',
      },
      text: {
        type: 'string',
        description: 'Text to type or element text to click',
      },
      key: {
        type: 'string',
        description: 'Key to press (Enter, Tab, Escape, ArrowDown, etc.)',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down'],
        description: 'Scroll direction',
      },
      amount: {
        type: 'number',
        description: 'Scroll amount in pixels (default: 300)',
      },
      tabId: {
        type: 'string',
        description: 'Target tab ID (optional, uses active tab)',
      },
      timeout: {
        type: 'number',
        description: 'Wait timeout in milliseconds (default: 5000)',
      },
      width: {
        type: 'number',
        description: 'Viewport width for set_viewport',
      },
      height: {
        type: 'number',
        description: 'Viewport height for set_viewport',
      },
      fullPage: {
        type: 'boolean',
        description: 'Capture full page screenshot (default: false)',
      },
      formData: {
        type: 'object',
        description: 'Form fields as {selector: value} pairs',
      },
      analyze: {
        type: 'boolean',
        description: 'Enable AI analysis for screenshot action (default: false)',
      },
      prompt: {
        type: 'string',
        description: 'Custom prompt for AI analysis',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as BrowserActionType;
    const url = params.url as string | undefined;
    const selector = params.selector as string | undefined;
    const text = params.text as string | undefined;
    const key = params.key as string | undefined;
    const direction = params.direction as 'up' | 'down' | undefined;
    const amount = params.amount as number | undefined;
    const tabId = params.tabId as string | undefined;
    const timeout = params.timeout as number | undefined;
    const width = params.width as number | undefined;
    const height = params.height as number | undefined;
    const fullPage = params.fullPage as boolean | undefined;
    const formData = params.formData as Record<string, string> | undefined;
    const analyze = params.analyze as boolean | undefined;
    const analysisPrompt = (params.prompt as string) || `请分析这个网页截图的内容，包括：
1. 页面的主要用途和类型
2. 可见的主要元素（按钮、链接、表单等）
3. 关键的文字信息
4. 当前的页面状态`;

    const workbenchPolicy = evaluateBrowserWorkbenchPolicy({
      toolName: 'browser_action',
      action,
      executionIntent: context.executionIntent,
    });
    if (workbenchPolicy.decision === 'block') {
      return buildBrowserWorkbenchBlockedResult(workbenchPolicy, {
        toolName: 'browser_action',
        action,
      });
    }

    const workbenchNotes: Array<string | null | undefined> = [workbenchPolicy.note];
    if (workbenchPolicy.preferManagedBrowser && MANAGED_SESSION_ACTIONS.has(action)) {
      workbenchNotes.push(await ensureManagedBrowserSessionForWorkbench());
    }

    const trace = browserService.beginTrace({
      toolName: 'browser_action',
      action,
      params,
    });

    try {
      const rawResult = await (async (): Promise<ToolExecutionResult> => {
        switch (action) {
        // Browser lifecycle
        case 'launch':
          await browserService.launch();
          return { success: true, output: 'Browser launched successfully' };

        case 'close':
          await browserService.close();
          return { success: true, output: 'Browser closed' };

        // Tab management
        case 'new_tab': {
          const newTabId = await browserService.newTab(url);
          const tabs = browserService.listTabs();
          const tab = tabs.find(t => t.id === newTabId);
          return {
            success: true,
            output: `New tab created: ${newTabId}\nURL: ${tab?.url || 'about:blank'}\nTitle: ${tab?.title || 'New Tab'}`,
          };
        }

        case 'close_tab':
          if (!tabId) {
            return { success: false, error: 'tabId required for close_tab' };
          }
          await browserService.closeTab(tabId);
          return { success: true, output: `Tab closed: ${tabId}` };

        case 'list_tabs': {
          const tabs = browserService.listTabs();
          if (tabs.length === 0) {
            return { success: true, output: 'No tabs open. Use "launch" and "new_tab" first.' };
          }
          const tabList = tabs.map(t => `- ${t.id}: ${t.title} (${t.url})`).join('\n');
          return { success: true, output: `Open tabs:\n${tabList}` };
        }

        case 'switch_tab':
          if (!tabId) {
            return { success: false, error: 'tabId required for switch_tab' };
          }
          await browserService.switchTab(tabId);
          return { success: true, output: `Switched to tab: ${tabId}` };

        // Navigation
        case 'navigate': {
          if (!url) {
            return { success: false, error: 'url required for navigate' };
          }
          await browserService.navigate(url, tabId);
          const content = await browserService.getPageContent(tabId);
          return {
            success: true,
            output: `Navigated to: ${content.url}\nTitle: ${content.title}`,
          };
        }

        case 'back':
          await browserService.goBack(tabId);
          return { success: true, output: 'Navigated back' };

        case 'forward':
          await browserService.goForward(tabId);
          return { success: true, output: 'Navigated forward' };

        case 'reload':
          await browserService.reload(tabId);
          return { success: true, output: 'Page reloaded' };

        case 'set_viewport':
          if (!width || !height) {
            return { success: false, error: 'width and height required for set_viewport' };
          }
          await browserService.setViewport(width, height);
          return {
            success: true,
            output: `Viewport set to ${Math.floor(width)}x${Math.floor(height)}`,
            metadata: {
              viewport: { width: Math.floor(width), height: Math.floor(height) },
            },
          };

        // Interactions
        case 'click':
          if (!selector) {
            return { success: false, error: 'selector required for click' };
          }
          await browserService.click(selector, tabId);
          return { success: true, output: `Clicked element: ${selector}` };

        case 'click_text': {
          if (!text) {
            return { success: false, error: 'text required for click_text' };
          }
          const element = await browserService.findElementByText(text, tabId);
          if (!element) {
            return { success: false, error: `Element with text "${text}" not found` };
          }
          // Click using text selector
          const tab = browserService.getActiveTab();
          if (tab) {
            await tab.page.click(`text=${text}`);
          }
          return { success: true, output: `Clicked element with text: "${text}"` };
        }

        case 'type':
          if (!selector) {
            return { success: false, error: 'selector required for type' };
          }
          if (text === undefined) {
            return { success: false, error: 'text required for type' };
          }
          await browserService.type(selector, text, tabId);
          return { success: true, output: `Typed "${text}" into ${selector}` };

        case 'press_key':
          if (!key) {
            return { success: false, error: 'key required for press_key' };
          }
          await browserService.pressKey(key, tabId);
          return { success: true, output: `Pressed key: ${key}` };

        case 'scroll':
          await browserService.scroll(direction || 'down', amount || 300, tabId);
          return { success: true, output: `Scrolled ${direction || 'down'} by ${amount || 300}px` };

        // Content
        case 'screenshot': {
          const result = await browserService.screenshot({
            fullPage: fullPage || false,
            selector,
            tabId,
          });
          if (!result.success) {
            return { success: false, error: result.error };
          }

          let output = `Screenshot saved: ${result.path}`;

          // 如果启用分析，进行视觉分析
          if (analyze && result.path) {
            logger.info('[浏览器截图] 启用视觉分析');
            const analysis = await analyzeImageWithVision({
              imagePath: result.path,
              prompt: analysisPrompt,
              source: 'browser_action.screenshot',
            });
            if (analysis) {
              output += `\n\n📝 AI 分析结果:\n${analysis}`;
            }
          }

          return {
            success: true,
            output,
            metadata: {
              path: result.path,
              analyzed: !!analyze,
            },
          };
        }

        case 'get_content': {
          const pageContent = await browserService.getPageContent(tabId);
          let output = `URL: ${pageContent.url}\nTitle: ${pageContent.title}\n\n`;
          output += `--- Page Text (first 5000 chars) ---\n${pageContent.text.substring(0, 5000)}\n\n`;
          if (pageContent.links && pageContent.links.length > 0) {
            output += `--- Links (${pageContent.links.length}) ---\n`;
            output += pageContent.links.slice(0, 20).map(l => `- [${l.text}](${l.href})`).join('\n');
          }
          return { success: true, output };
        }

        case 'get_elements': {
          if (!selector) {
            return { success: false, error: 'selector required for get_elements' };
          }
          const elements = await browserService.findElements(selector, tabId);
          if (elements.length === 0) {
            return { success: true, output: `No elements found for selector: ${selector}` };
          }
          const elementList = elements.map((e, i) =>
            `${i + 1}. <${e.tagName}> "${e.text.substring(0, 50)}" at (${Math.round(e.rect.x)}, ${Math.round(e.rect.y)})`
          ).join('\n');
          return { success: true, output: `Found ${elements.length} elements:\n${elementList}` };
        }

        case 'get_dom_snapshot': {
          const snapshot = await browserService.getDomSnapshot(tabId);
          return {
            success: true,
            output: JSON.stringify(snapshot, null, 2),
            metadata: {
              domSnapshot: snapshot,
            },
          };
        }

        case 'get_a11y_snapshot': {
          const snapshot = await browserService.getAccessibilitySnapshot(tabId);
          return {
            success: true,
            output: JSON.stringify(snapshot, null, 2),
            metadata: {
              accessibilitySnapshot: snapshot,
            },
          };
        }

        case 'get_workbench_state': {
          const state = browserService.getSessionState();
          return {
            success: true,
            output: JSON.stringify(state, null, 2),
            metadata: {
              browserWorkbenchState: state,
            },
          };
        }

        // Wait
        case 'wait':
          if (selector) {
            const found = await browserService.waitForSelector(selector, timeout || 5000, tabId);
            return {
              success: true,
              output: found ? `Element found: ${selector}` : `Timeout waiting for: ${selector}`,
            };
          } else {
            await browserService.waitForTimeout(timeout || 1000);
            return { success: true, output: `Waited ${timeout || 1000}ms` };
          }

        // Form
        case 'fill_form': {
          if (!formData) {
            return { success: false, error: 'formData required for fill_form' };
          }
          await browserService.fillForm(formData, tabId);
          const fields = Object.keys(formData).join(', ');
          return { success: true, output: `Filled form fields: ${fields}` };
        }

        // Logs - for debugging and transparency
        case 'get_logs': {
          const logCount = (params.count as number) || 20;
          const logs = browserService.logger.getLogsAsString(logCount);
          return {
            success: true,
            output: logs || 'No logs available yet. Try performing some browser actions first.',
          };
        }

        default:
          return { success: false, error: `Unknown action: ${action}` };
        }
      })();
      const completedTrace = browserService.finishTrace(trace, {
        success: rawResult.success,
        error: rawResult.error || null,
        screenshotPath: getScreenshotPathFromResult(rawResult),
      });
      return appendBrowserWorkbenchNote(withWorkbenchTrace(rawResult, completedTrace), workbenchNotes);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      browserService.logger.log('ERROR', `Action "${action}" failed: ${errorMessage}`);
      const completedTrace = browserService.finishTrace(trace, {
        success: false,
        error: errorMessage,
      });

      // Get recent logs for debugging
      const recentLogs = browserService.logger.getLogsAsString(5);

      // Provide helpful error messages
      if (errorMessage.includes('No active tab')) {
        return appendBrowserWorkbenchNote(withWorkbenchTrace({
          success: false,
          error: `${errorMessage}. Use "launch" then "new_tab" first.\n\n--- Recent Logs ---\n${recentLogs}`,
        }, completedTrace), workbenchNotes);
      }
      if (errorMessage.includes('Timeout')) {
        return appendBrowserWorkbenchNote(withWorkbenchTrace({
          success: false,
          error: `Timeout: ${errorMessage}. Try increasing timeout or check if element exists.\n\n--- Recent Logs ---\n${recentLogs}`,
        }, completedTrace), workbenchNotes);
      }

      return appendBrowserWorkbenchNote(withWorkbenchTrace({
        success: false,
        error: `${errorMessage}\n\n--- Recent Logs ---\n${recentLogs}`,
      }, completedTrace), workbenchNotes);
    }
  },
};

function getScreenshotPathFromResult(result: ToolExecutionResult): string | null {
  const path = result.metadata?.path;
  return typeof path === 'string' ? path : null;
}

function withWorkbenchTrace(
  result: ToolExecutionResult,
  trace: ReturnType<typeof browserService.finishTrace>,
): ToolExecutionResult {
  return {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      traceId: trace.id,
      workbenchTrace: trace,
    },
  };
}
