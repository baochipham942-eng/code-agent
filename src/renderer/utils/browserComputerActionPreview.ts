import type { ToolCall } from '@shared/contract';
import {
  redactBrowserComputerInputPayloadsInValue,
  sanitizeBrowserComputerMetadata,
} from '@shared/utils/browserComputerRedaction';

export type BrowserComputerActionRisk = 'read' | 'browser_action' | 'desktop_input';

export interface BrowserComputerActionPreview {
  surface: 'browser' | 'computer';
  summary: string;
  target?: string | null;
  risk: BrowserComputerActionRisk;
  riskLabel: string;
  traceId?: string | null;
  mode?: string | null;
}

const BROWSER_READ_ACTIONS = new Set([
  'list_tabs',
  'get_content',
  'get_elements',
  'get_dom_snapshot',
  'get_a11y_snapshot',
  'get_workbench_state',
  'get_logs',
  'screenshot',
  'wait',
]);

const COMPUTER_READ_ACTIONS = new Set([
  'get_state',
  'observe',
  'get_ax_elements',
  'locate_element',
  'locate_text',
  'locate_role',
  'get_elements',
]);

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function truncate(value: string, maxLength = 72): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function formatUrlTarget(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return `${parsed.hostname}${truncate(path, 36)}`;
  } catch {
    return truncate(url);
  }
}

function formatSelector(args: Record<string, unknown>): string | null {
  const axPath = asString(args.axPath);
  if (axPath) return `axPath ${truncate(axPath, 40)}`;

  const selector = asString(args.selector);
  if (selector) return selector;

  const role = asString(args.role);
  const name = asString(args.name);
  if (role && name) return `${role} "${truncate(name, 40)}"`;
  if (role) return role;

  const text = asString(args.text);
  if (text) return `"${truncate(text, 40)}"`;

  const x = asNumber(args.x);
  const y = asNumber(args.y);
  if (x !== null && y !== null) return `${x},${y}`;

  return null;
}

function formatSelectorWithoutInputText(args: Record<string, unknown>): string | null {
  const { text: _text, ...targetArgs } = args;
  return formatSelector(targetArgs);
}

function formatDesktopElementTarget(args: Record<string, unknown>): string | null {
  const axPath = asString(args.axPath);
  if (axPath) return `axPath ${truncate(axPath, 40)}`;

  const selector = asString(args.selector);
  if (selector) return selector;

  const role = asString(args.role);
  const name = asString(args.name);
  if (role && name) return `${role} "${truncate(name, 40)}"`;
  if (role) return role;
  if (name) return `"${truncate(name, 40)}"`;

  return null;
}

function formatTypedText(args: Record<string, unknown>): string {
  const text = asString(args.text);
  return text ? `${text.length} chars` : 'text';
}

function isInputPayloadAction(action: string): boolean {
  return action === 'type' || action === 'smart_type' || action === 'fill_form';
}

function getTraceMetadata(toolCall: Pick<ToolCall, 'result'>): {
  traceId: string | null;
  mode: string | null;
} {
  const metadata = toolCall.result?.metadata;
  const trace = metadata?.workbenchTrace as { id?: unknown; mode?: unknown } | undefined;
  return {
    traceId: asString(metadata?.traceId) || asString(trace?.id),
    mode: asString(trace?.mode),
  };
}

function buildBrowserSummary(action: string, args: Record<string, unknown>): {
  summary: string;
  target?: string | null;
} {
  switch (action) {
    case 'launch':
      return { summary: '启动托管浏览器' };
    case 'close':
      return { summary: '关闭托管浏览器' };
    case 'new_tab':
      return { summary: '打开新标签页', target: formatUrlTarget(asString(args.url)) };
    case 'close_tab':
      return { summary: '关闭标签页', target: asString(args.tabId) };
    case 'switch_tab':
      return { summary: '切换标签页', target: asString(args.tabId) };
    case 'navigate':
      return { summary: '导航到页面', target: formatUrlTarget(asString(args.url)) };
    case 'back':
      return { summary: '浏览器后退' };
    case 'forward':
      return { summary: '浏览器前进' };
    case 'reload':
      return { summary: '刷新页面' };
    case 'set_viewport': {
      const width = asNumber(args.width);
      const height = asNumber(args.height);
      return {
        summary: '设置 viewport',
        target: width && height ? `${width}x${height}` : null,
      };
    }
    case 'click':
      return { summary: '点击页面元素', target: formatSelector(args) };
    case 'click_text':
      return { summary: '点击页面文本', target: formatSelector(args) };
    case 'type':
      return { summary: `输入 ${formatTypedText(args)}`, target: formatSelectorWithoutInputText(args) };
    case 'press_key':
      return { summary: '按键', target: asString(args.key) };
    case 'scroll':
      return { summary: '滚动页面', target: asString(args.direction) || null };
    case 'screenshot':
      return { summary: '截取页面截图', target: args.fullPage ? 'full page' : null };
    case 'get_content':
      return { summary: '读取页面内容' };
    case 'get_elements':
      return { summary: '读取页面元素', target: asString(args.selector) };
    case 'get_dom_snapshot':
      return { summary: '读取 DOM snapshot' };
    case 'get_a11y_snapshot':
      return { summary: '读取 accessibility snapshot' };
    case 'get_workbench_state':
      return { summary: '读取 browser workbench state' };
    case 'wait':
      return { summary: '等待页面状态', target: formatSelector(args) || asString(args.timeout) };
    case 'fill_form': {
      const formData = args.formData && typeof args.formData === 'object'
        ? Object.keys(args.formData as Record<string, unknown>).length
        : 0;
      return { summary: '填写表单', target: formData ? `${formData} fields` : null };
    }
    case 'get_logs':
      return { summary: '读取浏览器日志' };
    default:
      return { summary: `浏览器动作: ${action}` };
  }
}

function buildComputerSummary(action: string, args: Record<string, unknown>): {
  summary: string;
  target?: string | null;
} {
  switch (action) {
    case 'get_state':
      return { summary: '读取 Computer Surface 状态' };
    case 'observe':
      return {
        summary: args.targetApp ? '观察目标 app/window' : '观察前台窗口',
        target: asString(args.targetApp) || (args.includeScreenshot ? 'with screenshot' : null),
      };
    case 'get_ax_elements':
      return { summary: '读取后台 AX 元素', target: asString(args.targetApp) };
    case 'click':
    case 'doubleClick':
    case 'rightClick':
      return {
        summary: args.targetApp && (args.axPath || args.role || args.name || args.selector) ? `${action} 后台元素` : `${action} 坐标`,
        target: formatSelector(args) || asString(args.targetApp),
      };
    case 'move':
      return { summary: '移动鼠标', target: formatSelector(args) };
    case 'type':
      return { summary: `桌面输入 ${formatTypedText(args)}`, target: formatDesktopElementTarget(args) || asString(args.targetApp) };
    case 'key': {
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers.join('+') : '';
      return { summary: '桌面按键', target: [modifiers, asString(args.key)].filter(Boolean).join('+') || null };
    }
    case 'scroll':
      return { summary: '桌面滚动', target: asString(args.direction) || null };
    case 'drag': {
      const from = formatSelector(args);
      const toX = asNumber(args.toX);
      const toY = asNumber(args.toY);
      const to = toX !== null && toY !== null ? `${toX},${toY}` : null;
      return { summary: '桌面拖拽', target: [from, to].filter(Boolean).join(' -> ') || null };
    }
    case 'locate_element':
      return { summary: '定位页面元素', target: asString(args.selector) };
    case 'locate_text':
      return { summary: '定位页面文本', target: asString(args.text) };
    case 'locate_role':
      return { summary: '定位 ARIA role', target: formatSelector(args) };
    case 'smart_click':
      return { summary: '智能点击浏览器元素', target: formatSelector(args) };
    case 'smart_type':
      return { summary: `智能输入 ${formatTypedText(args)}`, target: formatSelectorWithoutInputText(args) };
    case 'smart_hover':
      return { summary: '智能 hover 浏览器元素', target: formatSelector(args) };
    case 'get_elements':
      return { summary: '读取可交互元素' };
    default:
      return { summary: `Computer action: ${action}` };
  }
}

export function buildBrowserComputerActionPreview(
  toolCall: Pick<ToolCall, 'name' | 'arguments' | 'result'>,
): BrowserComputerActionPreview | null {
  if (toolCall.name !== 'browser_action' && toolCall.name !== 'computer_use') {
    return null;
  }

  const args = toolCall.arguments || {};
  const action = asString(args.action) || 'unknown';
  const { traceId, mode } = getTraceMetadata(toolCall);

  if (toolCall.name === 'browser_action') {
    const risk: BrowserComputerActionRisk = BROWSER_READ_ACTIONS.has(action) ? 'read' : 'browser_action';
    return {
      surface: 'browser',
      ...buildBrowserSummary(action, args),
      risk,
      riskLabel: risk === 'read' ? '只读' : '托管浏览器动作',
      traceId,
      mode,
    };
  }

  const risk: BrowserComputerActionRisk = COMPUTER_READ_ACTIONS.has(action) ? 'read' : 'desktop_input';
  const summary = buildComputerSummary(action, args);
  const metadataTargetApp = asString(toolCall.result?.metadata?.targetApp);
  return {
    surface: 'computer',
    ...summary,
    target: summary.target || metadataTargetApp,
    risk,
    riskLabel: risk === 'read' ? '只读' : '桌面输入',
    traceId,
    mode,
  };
}

function basename(path: unknown): string | null {
  const value = asString(path);
  if (!value) return null;
  return value.split('/').filter(Boolean).pop() || value;
}

function countArray(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function parseFoundCount(output: unknown): string | null {
  if (typeof output !== 'string') return null;
  const match = output.match(/Found\s+(\d+)\s+/i);
  if (match) return `${match[1]} items`;
  if (/No (?:visible )?(?:interactive )?elements found/i.test(output)) return '0 items';
  return null;
}

function joinResultSummary(preview: BrowserComputerActionPreview): string {
  return preview.target ? `${preview.summary} -> ${preview.target}` : preview.summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function redactForTool(toolName: string, args: Record<string, unknown>, value: unknown): string | null {
  const redacted = redactBrowserComputerInputPayloadsInValue(toolName, args, value);
  if (typeof redacted === 'string' && redacted.trim()) {
    return redacted.trim();
  }
  return null;
}

function formatRecoveryOutcome(
  toolName: string,
  args: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string | null {
  const safeMetadata = sanitizeBrowserComputerMetadata(toolName, args, metadata) || {};
  const outcome = safeMetadata.browserComputerRecoveryActionOutcome;
  if (!isRecord(outcome)) {
    return null;
  }

  const lines: string[] = [];
  const title = redactForTool(toolName, args, outcome.title);
  if (title) {
    lines.push(title);
  }

  if (Array.isArray(outcome.evidence)) {
    for (const evidence of outcome.evidence) {
      const safeEvidence = redactForTool(toolName, args, evidence);
      if (safeEvidence) {
        lines.push(safeEvidence);
      }
    }
  }

  const retryHint = redactForTool(toolName, args, outcome.retryHint);
  if (retryHint) {
    lines.push(`建议：${retryHint}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function formatInputFailureDetail(
  toolName: string,
  args: Record<string, unknown>,
  preview: BrowserComputerActionPreview,
  error: unknown,
): string | null {
  if (typeof error !== 'string') {
    return null;
  }
  const safeError = redactForTool(toolName, args, error) || error;
  const lower = error.toLowerCase();
  if (lower.includes('no element found') || lower.includes('element not found') || lower.includes('target element')) {
    return `${joinResultSummary(preview)} 没执行成功：目标元素未找到。${safeError ? ` ${safeError}` : ''}`;
  }
  return null;
}

export function summarizeBrowserComputerActionResult(
  toolCall: Pick<ToolCall, 'name' | 'arguments' | 'result'>,
): string | null {
  if (!toolCall.result) {
    return null;
  }

  const preview = buildBrowserComputerActionPreview(toolCall);
  if (!preview) {
    return null;
  }

  const args = toolCall.arguments || {};
  const action = asString(args.action) || 'unknown';
  const metadata = toolCall.result.metadata || {};

  if (!toolCall.result.success) {
    return isInputPayloadAction(action) ? `${joinResultSummary(preview)} failed` : null;
  }

  if (toolCall.name === 'browser_action') {
    switch (action) {
      case 'screenshot': {
        const fileName = basename(metadata.path);
        return fileName ? `截图已保存: ${fileName}` : '截图已保存';
      }
      case 'get_elements':
        return parseFoundCount(toolCall.result.output) || joinResultSummary(preview);
      case 'get_dom_snapshot': {
        const headings = countArray((metadata.domSnapshot as Record<string, unknown> | undefined)?.headings);
        const interactive = countArray((metadata.domSnapshot as Record<string, unknown> | undefined)?.interactive);
        if (headings !== null || interactive !== null) {
          return `DOM snapshot: ${headings ?? 0} headings · ${interactive ?? 0} interactive`;
        }
        return 'DOM snapshot 已读取';
      }
      case 'get_a11y_snapshot':
        return 'Accessibility snapshot 已读取';
      case 'get_workbench_state':
        return 'Browser workbench state 已读取';
      case 'get_content':
        return '页面内容已读取';
      case 'get_logs':
        return '浏览器日志已读取';
      default:
        return joinResultSummary(preview);
    }
  }

  switch (action) {
    case 'get_state': {
      const surface = metadata.computerSurface as { ready?: unknown; mode?: unknown } | undefined;
      if (surface) {
        return `Computer Surface: ${surface.ready ? 'ready' : 'not ready'} · ${asString(surface.mode) || 'unknown'}`;
      }
      return joinResultSummary(preview);
    }
    case 'observe': {
      const snapshot = metadata.computerSurfaceSnapshot as { appName?: unknown; windowTitle?: unknown; screenshotPath?: unknown } | undefined;
      if (!snapshot) return joinResultSummary(preview);
      const app = asString(snapshot.appName) || 'unknown';
      const windowTitle = asString(snapshot.windowTitle);
      const screenshot = basename(snapshot.screenshotPath);
      return [
        `Frontmost: ${windowTitle ? `${app} · ${truncate(windowTitle, 36)}` : app}`,
        screenshot ? `screenshot ${screenshot}` : null,
      ].filter(Boolean).join(' · ');
    }
    case 'get_ax_elements': {
      const elements = countArray(metadata.elements);
      return elements !== null ? `${elements} background AX elements` : parseFoundCount(toolCall.result.output) || joinResultSummary(preview);
    }
    case 'get_elements': {
      const elements = countArray(metadata.elements);
      return elements !== null ? `${elements} interactive elements` : parseFoundCount(toolCall.result.output) || joinResultSummary(preview);
    }
    default:
      return joinResultSummary(preview);
  }
}

function redactTextPreview(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return text ? `[redacted ${text.length} chars]` : '[redacted text]';
}

function redactFormData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '[redacted form data]';
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([field, fieldValue]) => [
      field,
      redactTextPreview(fieldValue),
    ]),
  );
}

export function formatBrowserComputerActionArguments(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName !== 'browser_action' && toolName !== 'computer_use') {
    return null;
  }

  const action = asString(args.action) || 'unknown';
  if (!isInputPayloadAction(action)) {
    return null;
  }

  const safeArgs = { ...args };
  if ('text' in safeArgs) {
    safeArgs.text = redactTextPreview(safeArgs.text);
  }
  if ('formData' in safeArgs) {
    safeArgs.formData = redactFormData(safeArgs.formData);
  }

  return JSON.stringify(safeArgs, null, 2);
}

export function formatBrowserComputerActionResultDetails(
  toolCall: Pick<ToolCall, 'name' | 'arguments' | 'result'>,
): string | null {
  const metadata = toolCall.result?.metadata || {};
  const args = toolCall.arguments || {};
  const recovery = formatRecoveryOutcome(toolCall.name, args, metadata);
  if (recovery) {
    return recovery;
  }

  const action = asString(toolCall.arguments?.action) || 'unknown';
  if (!isInputPayloadAction(action)) {
    return null;
  }

  const preview = buildBrowserComputerActionPreview(toolCall);
  if (preview && toolCall.result && !toolCall.result.success) {
    const failureDetail = formatInputFailureDetail(toolCall.name, args, preview, toolCall.result.error);
    if (failureDetail) {
      return failureDetail;
    }
  }

  return summarizeBrowserComputerActionResult(toolCall);
}
