// ============================================================================
// Browser Action Tool - Comprehensive browser automation with AI vision
// Available for tool-calling runtimes
// Playwright-based browser control for testing and automation
// 支持智谱 GLM-4.6V-Flash 视觉分析
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import type { BrowserTargetRef } from '../../services/infra/browserService.js';
import { getBrowserService } from '../../services/infra/browserPool.js';
import { createLogger } from '../../services/infra/logger';
import { analyzeImageWithVision } from '../../services/desktop/visionAnalysisService';
import {
  appendBrowserWorkbenchNote,
  buildBrowserWorkbenchBlockedResult,
  ensureManagedBrowserSessionForWorkbench,
  evaluateBrowserWorkbenchPolicy,
} from './browserWorkbenchIntent';
import { executeBrowserProfileAction } from './browserProfileActions';
import { maybeDispatchRelayBrowserAction } from './browserEngineDispatch';
import { requestBrowserUploadApproval } from './browserUploadApproval';
import { createManagedBrowserOperationId, getManagedBrowserProviderAdapter, surfaceIdentityFromToolContext } from '../../services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  formatBrowserTargetRefLabel,
  getBrowserTargetRefErrorDetails,
  getScreenshotPathFromResult,
  resolveBrowserSecretRef,
  summarizeAccountStateForTool,
  summarizeBrowserArtifactForTool,
  summarizeBrowserTargetRefForTool,
  summarizeManagedBrowserStateForTool,
  summarizePathTail,
  summarizeSecretRef,
  withWorkbenchTrace,
} from './browserActionResultProjection';
import { maybeExecuteBrowserSurfaceInteraction } from './browserActionSurfaceInteractions';

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
  | 'hover'
  | 'drag'
  | 'get_dialog_state'
  | 'handle_dialog'
  | 'read_clipboard'
  | 'write_clipboard'
  | 'screenshot'
  | 'get_content'
  | 'get_elements'
  | 'get_dom_snapshot'
  | 'get_a11y_snapshot'
  | 'get_workbench_state'
  | 'get_account_state'
  | 'export_storage_state'
  | 'import_storage_state'
  | 'list_profiles'
  | 'import_profile_cookies'
  | 'clear_cookies'
  | 'wait_for_download'
  | 'upload_file'
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
  'hover',
  'drag',
  'get_dialog_state',
  'handle_dialog',
  'read_clipboard',
  'write_clipboard',
  'screenshot',
  'get_content',
  'get_elements',
  'get_dom_snapshot',
  'get_a11y_snapshot',
  'get_workbench_state',
  'get_account_state',
  'export_storage_state',
  'import_storage_state',
  'import_profile_cookies',
  'clear_cookies',
  'wait_for_download',
  'upload_file',
  'wait',
  'fill_form',
]);

export const browserActionTool: Tool = {
  name: 'browser_action',
  description: `Control a browser for web automation and testing (tabs, click/type, screenshots, DOM/a11y snapshots, forms, uploads/downloads, account state).

Routing: prefer web_fetch/search for plain reads; use browser_action for login/session, multi-page, or visual work. After mutations, refresh DOM/a11y evidence before claiming final state.
engine (ADR-041): optional auto|managed|relay (default auto). Explicit managed/relay never silent-switches. managed=Neo isolated browser; relay=user-attached Chrome tab.
Profile login reuse: list_profiles; import_profile_cookies recognizes the legacy userConfirmed signal but also requires a one-time Host approval bound to profile/domain scope; clear_cookies clears managed profile cookies. Never log cookie values.
storageState file path: export_storage_state / import_storage_state for CI/scripts.`,
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
          'click', 'click_text', 'type', 'press_key', 'scroll', 'hover', 'drag',
          'get_dialog_state', 'handle_dialog', 'read_clipboard', 'write_clipboard',
          'screenshot', 'get_content', 'get_elements', 'get_dom_snapshot', 'get_a11y_snapshot',
          'get_workbench_state', 'get_account_state', 'export_storage_state', 'import_storage_state',
          'list_profiles', 'import_profile_cookies', 'clear_cookies',
          'wait_for_download', 'upload_file', 'wait', 'fill_form', 'get_logs'
        ],
        description: 'The browser action to perform',
      },
      url: {
        type: 'string',
        description: 'URL for navigate/new_tab actions',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for element interactions. Prefer targetRef from get_dom_snapshot when available.',
      },
      targetRef: {
        type: 'object',
        description: 'Short-lived target reference returned by get_dom_snapshot interactiveElements[].targetRef',
        additionalProperties: true,
      },
      destinationTargetRef: {
        type: 'object',
        description: 'Fresh destination targetRef for drag. Both drag endpoints must come from the same current DOM snapshot.',
        additionalProperties: true,
      },
      text: {
        type: 'string',
        description: 'Text to type or element text to click',
      },
      clipboardText: {
        type: 'string',
        description: 'Sensitive text for write_clipboard. It requires explicit approval and is redacted from traces, proof, and export.',
      },
      dialogAction: {
        type: 'string',
        enum: ['accept', 'dismiss'],
        description: 'Explicit action for a currently paused JavaScript dialog. Dialogs pause by default.',
      },
      dialogPromptText: {
        type: 'string',
        description: 'Sensitive prompt response used only with dialogAction=accept on a prompt dialog.',
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
        description: 'Managed Browser tab reference. Relay never accepts native tab IDs.',
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
      storageStatePath: {
        type: 'string',
        description: 'Local path for import_storage_state/export_storage_state. Export creates an artifact path when omitted.',
      },
      uploadFilePath: {
        type: 'string',
        description: 'Local file path for upload_file. Every upload requires one-time approval for the exact normalized file; Relay also requires a fresh targetRef.',
      },
      secretRef: {
        type: 'string',
        description: 'Reference to a secret value for type actions, e.g. env:CODE_AGENT_BROWSER_SECRET_PASSWORD. The secret value is never returned in output.',
      },
      engine: {
        type: 'string',
        enum: ['auto', 'managed', 'relay'],
        description:
          'ADR-041 browser engine. auto (default) routes by isolation/login intent; managed uses Neo isolated browser; relay drives an attached real Chrome tab. Explicit managed/relay never silently switches engines.',
      },
      relayDomainScopes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact HTTP(S) origins or hostnames the user may approve for a time-bounded Relay tab lease.',
      },
      relayActionScopes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Explicit browser actions the user may approve for the Relay tab lease; wildcards are rejected.',
      },
      relayLeaseTtlMs: {
        type: 'number',
        description: 'Requested Relay lease lifetime in milliseconds, capped at 30 minutes.',
      },
      source: {
        type: 'string',
        description: 'Browser profile source for list_profiles/import_profile_cookies (chrome, edge, brave, arc, …)',
      },
      profileId: {
        type: 'string',
        description: 'Browser profile id for import_profile_cookies (e.g. Default, Profile 1)',
      },
      domainAllowlist: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional domain allowlist for import_profile_cookies',
      },
      userConfirmed: {
        type: 'boolean',
        description: 'Legacy compatibility signal for import_profile_cookies. It cannot authorize import without a one-time Host permission bound to the exact profile/domain scope (ADR-041).',
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
    const targetRef = params.targetRef as string | BrowserTargetRef | undefined;
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
    const storageStatePath = params.storageStatePath as string | undefined;
    const uploadFilePath = params.uploadFilePath as string | undefined;
    const secretRef = params.secretRef as string | undefined;
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
    const relayDispatch = await maybeDispatchRelayBrowserAction({
      action,
      params,
      url,
      executionIntent: context.executionIntent,
      context,
    });
    if (relayDispatch) {
      return relayDispatch;
    }

    const surfaceIdentity = surfaceIdentityFromToolContext(context);
    const useManagedSurface = Boolean(surfaceIdentity) && action !== 'list_profiles';
    const managedAdapter = getManagedBrowserProviderAdapter();
    // Native runs are isolated by conversation/run/agent. Legacy callers without
    // a complete owner identity keep the historical per-agent compatibility path.
    const browserService = useManagedSurface && surfaceIdentity
      ? managedAdapter.getBrowserService(surfaceIdentity)
      : getBrowserService(context.agentId);

    if (!useManagedSurface && workbenchPolicy.preferManagedBrowser && MANAGED_SESSION_ACTIONS.has(action)) {
      workbenchNotes.push(await ensureManagedBrowserSessionForWorkbench({ agentId: context.agentId }));
    }

    const trace = browserService.beginTrace({
      toolName: 'browser_action',
      action,
      params,
    });

    try {
      const executeManagedProviderAction = async (): Promise<ToolExecutionResult> => {
        const surfaceInteractionResult = await maybeExecuteBrowserSurfaceInteraction({
          action,
          browserService,
          context,
          params,
          tabId,
        });
        if (surfaceInteractionResult) {
          return surfaceInteractionResult;
        }

        switch (action) {
        // Browser lifecycle
        case 'launch':
          await browserService.launch({ leaseOwner: 'browser_action' });
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
          if (!tabId && !browserService.getActiveTab()) {
            await browserService.newTab();
            workbenchNotes.push('自动创建了空白标签页后继续导航');
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
        case 'click': {
          if (targetRef) {
            const resolved = await browserService.clickTargetRef(targetRef, tabId);
            return {
              success: true,
              output: `Clicked targetRef: ${formatBrowserTargetRefLabel(resolved)}`,
              metadata: {
                targetRef: summarizeBrowserTargetRefForTool(resolved),
              },
            };
          }
          if (!selector) {
            return { success: false, error: 'selector or targetRef required for click' };
          }
          const clickBoundingBox = await browserService.getElementBoundingBox(selector, tabId);
          await browserService.click(selector, tabId);
          return {
            success: true,
            output: `Clicked element: ${selector}`,
            metadata: {
              pointerTarget: {
                label: selector,
                selector,
                boundingBox: clickBoundingBox,
              },
            },
          };
        }

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
          return {
            success: true,
            output: `Clicked element with text: "${text}"`,
            metadata: {
              pointerTarget: {
                label: text,
                selector: `text=${text}`,
                boundingBox: element.rect,
              },
            },
          };
        }

        case 'type': {
          if (text === undefined && !secretRef) {
            return { success: false, error: 'text or secretRef required for type' };
          }
          const textToType = secretRef ? resolveBrowserSecretRef(secretRef) : text;
          if (textToType === undefined) {
            return { success: false, error: `secretRef unavailable: ${summarizeSecretRef(secretRef)}` };
          }
          if (targetRef) {
            const resolved = await browserService.typeTargetRef(targetRef, textToType, tabId);
            return {
              success: true,
              output: secretRef
                ? `Typed secretRef ${summarizeSecretRef(secretRef)} into targetRef: ${formatBrowserTargetRefLabel(resolved)}`
                : `Typed ${textToType.length} chars into targetRef: ${formatBrowserTargetRefLabel(resolved)}`,
              metadata: {
                targetRef: summarizeBrowserTargetRefForTool(resolved),
                secretRef: secretRef ? summarizeSecretRef(secretRef) : undefined,
              },
            };
          }
          if (!selector) {
            return { success: false, error: 'selector or targetRef required for type' };
          }
          const typeBoundingBox = await browserService.getElementBoundingBox(selector, tabId);
          await browserService.type(selector, textToType, tabId);
          return {
            success: true,
            output: secretRef
              ? `Typed secretRef ${summarizeSecretRef(secretRef)} into ${selector}`
              : `Typed ${textToType.length} chars into ${selector}`,
            metadata: {
              secretRef: secretRef ? summarizeSecretRef(secretRef) : undefined,
              pointerTarget: {
                label: selector,
                selector,
                boundingBox: typeBoundingBox,
              },
            },
          };
        }

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
          let analysisSucceeded = false;

          // 如果启用分析，进行视觉分析
          if (analyze && result.path) {
            logger.info('[浏览器截图] 启用视觉分析');
            const analysis = await analyzeImageWithVision({
              imagePath: result.path,
              prompt: analysisPrompt,
              source: 'browser_action.screenshot',
            });
            if (analysis) {
              analysisSucceeded = true;
              output += `\n\n📝 AI 分析结果:\n${analysis}`;
            }
          }

          return {
            success: true,
            output,
            metadata: { path: result.path, analyzed: analysisSucceeded, analysisRequested: !!analyze, ...(!analysisSucceeded ? { cannotObserveScreen: true } : {}) },
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
          const safeState = summarizeManagedBrowserStateForTool(state);
          return {
            success: true,
            output: JSON.stringify(safeState, null, 2),
            metadata: {
              browserWorkbenchState: safeState,
            },
          };
        }

        case 'get_account_state': {
          const accountState = await browserService.getAccountStateSummary();
          return {
            success: true,
            output: JSON.stringify(summarizeAccountStateForTool(accountState), null, 2),
            metadata: {
              browserAccountState: summarizeAccountStateForTool(accountState),
            },
          };
        }

        case 'export_storage_state': {
          const artifact = await browserService.exportStorageState(storageStatePath);
          return {
            success: true,
            output: `Storage state exported: ${summarizePathTail(artifact.path) || 'storage_state.json'}`,
            metadata: {
              storageStatePath: artifact.path,
              browserAccountState: summarizeAccountStateForTool(artifact.accountState),
            },
          };
        }

        case 'import_storage_state': {
          if (!storageStatePath) {
            return { success: false, error: 'storageStatePath required for import_storage_state' };
          }
          const accountState = await browserService.importStorageState(storageStatePath);
          return {
            success: true,
            output: `Storage state imported: ${summarizePathTail(storageStatePath) || 'storage_state.json'}`,
            metadata: {
              storageStatePath,
              browserAccountState: summarizeAccountStateForTool(accountState),
            },
          };
        }

        case 'list_profiles':
        case 'import_profile_cookies':
        case 'clear_cookies':
          return executeBrowserProfileAction({
            action,
            browserService,
            params,
            context,
          });

        case 'wait_for_download': {
          if (!selector && !targetRef) {
            return { success: false, error: 'selector or targetRef required for wait_for_download' };
          }
          const artifact = await browserService.waitForDownload({ selector, targetRef }, tabId);
          return {
            success: true,
            output: `Download completed: ${artifact.name} (${artifact.size} bytes, sha256=${artifact.sha256.slice(0, 12)})`,
            metadata: {
              browserArtifact: summarizeBrowserArtifactForTool(artifact),
            },
          };
        }

        case 'upload_file': {
          if (!uploadFilePath) {
            return { success: false, error: 'uploadFilePath required for upload_file' };
          }
          if (!selector && !targetRef) {
            return { success: false, error: 'selector or targetRef required for upload_file' };
          }
          const approval = await requestBrowserUploadApproval({
            filePath: uploadFilePath,
            context,
            engine: 'managed',
          });
          if (!approval.approved) {
            return {
              success: false,
              error: approval.reason,
              metadata: {
                code: approval.code,
              },
            };
          }
          const artifact = await browserService.uploadFile({
            approvedFile: approval.file,
            selector,
            targetRef,
            tabId,
          });
          return {
            success: true,
            output: `Upload file selected: ${artifact.name} (${artifact.size} bytes, sha256=${artifact.sha256.slice(0, 12)})`,
            metadata: {
              browserArtifact: summarizeBrowserArtifactForTool(artifact),
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
      };
      const rawResult = useManagedSurface && surfaceIdentity
        ? await managedAdapter.execute({
            identity: surfaceIdentity,
            operationId: createManagedBrowserOperationId(context, action),
            action,
            params,
            ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
            executeProvider: async () => executeManagedProviderAction(),
          })
        : await executeManagedProviderAction();
      const completedTrace = browserService.finishTrace(trace, {
        success: rawResult.success,
        error: rawResult.error || null,
        screenshotPath: getScreenshotPathFromResult(rawResult),
      });
      return appendBrowserWorkbenchNote(withWorkbenchTrace(rawResult, completedTrace, context), workbenchNotes);
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
      const targetRefError = getBrowserTargetRefErrorDetails(error);
      if (targetRefError) {
        return appendBrowserWorkbenchNote(withWorkbenchTrace({
          success: false,
          error: `${targetRefError.message}\n\nRecovery: ${targetRefError.retryHint}`,
          metadata: {
            code: targetRefError.code,
            recoverable: true,
            targetRef: {
              refId: targetRefError.refId,
              snapshotId: targetRefError.snapshotId,
            },
            browserComputerRecoveryActionOutcome: {
              status: 'recoverable',
              title: 'TargetRef is stale. Refresh the DOM snapshot and retry.',
              evidence: [
                targetRefError.refId ? `TargetRef: ${targetRefError.refId}` : 'TargetRef: missing',
                targetRefError.snapshotId ? `Snapshot: ${targetRefError.snapshotId}` : 'Snapshot: missing',
              ],
              retryHint: targetRefError.retryHint,
            },
          },
        }, completedTrace, context), workbenchNotes);
      }
      if (errorMessage.includes('No active tab')) {
        return appendBrowserWorkbenchNote(withWorkbenchTrace({
          success: false,
          error: `${errorMessage}. Use "launch" then "new_tab" first.\n\n--- Recent Logs ---\n${recentLogs}`,
        }, completedTrace, context), workbenchNotes);
      }
      if (errorMessage.includes('Timeout')) {
        return appendBrowserWorkbenchNote(withWorkbenchTrace({
          success: false,
          error: `Timeout: ${errorMessage}. Try increasing timeout or check if element exists.\n\n--- Recent Logs ---\n${recentLogs}`,
        }, completedTrace, context), workbenchNotes);
      }

      return appendBrowserWorkbenchNote(withWorkbenchTrace({
        success: false,
        error: `${errorMessage}\n\n--- Recent Logs ---\n${recentLogs}`,
      }, completedTrace, context), workbenchNotes);
    }
  },
};
