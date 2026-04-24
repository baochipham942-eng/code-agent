import type { ConversationExecutionIntent } from '../../../shared/contract/conversationEnvelope';
import type { ToolExecutionResult } from '../types';
import { browserService } from '../../services/infra/browserService.js';

const BROWSER_OS_ACTIONS = new Set([
  'open',
  'nav_back',
  'nav_forward',
  'refresh',
  'close_window',
  'newTab',
  'switchTab',
]);

const COMPUTER_USE_SMART_ACTIONS = new Set([
  'locate_element',
  'locate_text',
  'locate_role',
  'smart_click',
  'smart_type',
  'smart_hover',
  'get_elements',
]);

export type BrowserWorkbenchPathKind =
  | 'browser_os_navigation'
  | 'browser_managed_automation'
  | 'computer_use_basic'
  | 'computer_use_smart';

export interface BrowserWorkbenchPolicy {
  decision: 'allow' | 'block';
  pathKind: BrowserWorkbenchPathKind | null;
  preferManagedBrowser: boolean;
  note?: string;
  code?: 'WORKBENCH_BROWSER_BLOCKED' | 'WORKBENCH_BROWSER_AUTOMATION_DISABLED';
  detail?: string;
  hint?: string;
}

export function isComputerUseSmartAction(action: string | undefined): boolean {
  return action !== undefined && COMPUTER_USE_SMART_ACTIONS.has(action);
}

export function classifyBrowserWorkbenchPath(args: {
  toolName: string;
  action?: string;
}): BrowserWorkbenchPathKind | null {
  const { toolName, action } = args;
  if (toolName === 'Browser') {
    return BROWSER_OS_ACTIONS.has(action || '')
      ? 'browser_os_navigation'
      : 'browser_managed_automation';
  }
  if (toolName === 'browser_action') {
    return 'browser_managed_automation';
  }
  if (toolName === 'computer_use') {
    return isComputerUseSmartAction(action)
      ? 'computer_use_smart'
      : 'computer_use_basic';
  }
  return null;
}

function buildDesktopNotReadyPolicy(
  detail: string | undefined,
  hint: string | undefined,
): BrowserWorkbenchPolicy {
  return {
    decision: 'block',
    pathKind: null,
    preferManagedBrowser: false,
    code: 'WORKBENCH_BROWSER_BLOCKED',
    detail: detail || '当前桌面 Browser workbench 未就绪。',
    hint,
  };
}

function buildAutomationDisabledPolicy(): BrowserWorkbenchPolicy {
  return {
    decision: 'block',
    pathKind: null,
    preferManagedBrowser: false,
    code: 'WORKBENCH_BROWSER_AUTOMATION_DISABLED',
    detail: '当前 turn 绑定的是 Desktop Browser workbench，allowBrowserAutomation=false，本轮不要驱动托管浏览器自动化。',
    hint: '先基于当前桌面预览或截图继续；如果确实需要托管浏览器自动化，改选 Managed 后再试。',
  };
}

export function evaluateBrowserWorkbenchPolicy(args: {
  toolName: string;
  action?: string;
  executionIntent?: ConversationExecutionIntent;
}): BrowserWorkbenchPolicy {
  const pathKind = classifyBrowserWorkbenchPath(args);
  const intent = args.executionIntent;

  if (!pathKind || !intent) {
    return {
      decision: 'allow',
      pathKind,
      preferManagedBrowser: false,
    };
  }

  if (intent.browserSessionMode === 'managed') {
    const preferManagedBrowser = pathKind === 'browser_os_navigation'
      || pathKind === 'browser_managed_automation'
      || pathKind === 'computer_use_smart';

    return {
      decision: 'allow',
      pathKind,
      preferManagedBrowser,
      ...(pathKind === 'browser_os_navigation'
        ? { note: 'Workbench 已按当前 turn 的 Managed 选择改走托管浏览器会话。' }
        : {}),
    };
  }

  if (intent.browserSessionMode === 'desktop') {
    const snapshot = intent.browserSessionSnapshot;
    const desktopSensitivePath = pathKind === 'browser_managed_automation'
      || pathKind === 'computer_use_smart'
      || pathKind === 'computer_use_basic';

    if (desktopSensitivePath && snapshot && !snapshot.ready) {
      return buildDesktopNotReadyPolicy(snapshot.blockedDetail, snapshot.blockedHint);
    }

    if ((pathKind === 'browser_managed_automation' || pathKind === 'computer_use_smart')
      && intent.allowBrowserAutomation === false) {
      return buildAutomationDisabledPolicy();
    }
  }

  if ((pathKind === 'browser_managed_automation' || pathKind === 'computer_use_smart')
    && intent.allowBrowserAutomation === false) {
    return buildAutomationDisabledPolicy();
  }

  return {
    decision: 'allow',
    pathKind,
    preferManagedBrowser: false,
  };
}

export async function ensureManagedBrowserSessionForWorkbench(args: {
  url?: string;
} = {}): Promise<string | null> {
  const before = browserService.getSessionState();
  if (before.running && before.activeTab) {
    return null;
  }

  if (args.url) {
    await browserService.ensureSession(args.url);
  } else {
    await browserService.ensureSession();
  }

  const notes: string[] = [];
  if (!before.running) {
    notes.push('按当前 turn 的 Managed 选择自动启动了托管浏览器。');
  }
  if (!before.activeTab) {
    notes.push('已最小化补齐托管浏览器会话。');
  }

  return notes.length > 0
    ? notes.join(' ')
    : '按当前 turn 的 Managed 选择补齐了托管浏览器会话。';
}

export function appendBrowserWorkbenchNote(
  result: ToolExecutionResult,
  notes: Array<string | null | undefined>,
): ToolExecutionResult {
  const content = notes
    .map((note) => note?.trim())
    .filter((note): note is string => Boolean(note))
    .join('\n');

  if (!content) {
    return result;
  }

  if (result.success) {
    return {
      ...result,
      output: result.output ? `${content}\n${result.output}` : content,
      metadata: {
        ...(result.metadata || {}),
        workbenchNote: content,
      },
    };
  }

  return {
    ...result,
    error: result.error ? `${content}\n${result.error}` : content,
    metadata: {
      ...(result.metadata || {}),
      workbenchNote: content,
    },
  };
}

export function buildBrowserWorkbenchBlockedResult(
  policy: BrowserWorkbenchPolicy,
  args: {
    toolName: string;
    action?: string;
  },
): ToolExecutionResult {
  const actionLabel = args.action ? `${args.toolName}.${args.action}` : args.toolName;
  const lines = [
    `当前 Browser workbench 阻止了 ${actionLabel}：${policy.detail || '执行环境未就绪。'}`,
    policy.hint ? `修复提示：${policy.hint}` : null,
  ].filter(Boolean);

  return {
    success: false,
    error: lines.join('\n'),
    metadata: {
      code: policy.code || 'WORKBENCH_BROWSER_BLOCKED',
      workbenchBlocked: true,
      detail: policy.detail,
      hint: policy.hint,
    },
  };
}
