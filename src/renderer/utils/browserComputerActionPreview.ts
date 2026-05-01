import type { ToolCall } from '@shared/contract';
import {
  redactBrowserComputerInputPayloadsInValue,
  sanitizeBrowserComputerMetadata,
  summarizeBrowserComputerSecretScope,
} from '@shared/utils/browserComputerRedaction';
import {
  getBrowserComputerActionCatalogEntry,
  type BrowserComputerActionCatalogEntry,
  type BrowserComputerCatalogApprovalKind,
  type BrowserComputerCatalogEvidenceKind,
  type BrowserComputerCatalogRisk,
  type BrowserComputerCatalogSafeRecovery,
  type BrowserComputerCatalogScope,
  type BrowserComputerCatalogTool,
} from '@shared/utils/browserComputerActionCatalog';

export type BrowserComputerActionRisk = BrowserComputerCatalogRisk;

export interface BrowserComputerActionPreview {
  surface: 'browser' | 'computer';
  tool: BrowserComputerCatalogTool;
  action: string;
  summary: string;
  target?: string | null;
  risk: BrowserComputerActionRisk;
  riskLabel: string;
  scope: BrowserComputerCatalogScope;
  requiresManagedSession: boolean;
  evidenceKind: BrowserComputerCatalogEvidenceKind;
  approvalKind: BrowserComputerCatalogApprovalKind;
  safeRecovery: BrowserComputerCatalogSafeRecovery;
  traceId?: string | null;
  mode?: string | null;
}

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
  const targetRef = formatTargetRefTarget(args.targetRef);
  if (targetRef) return targetRef;

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

function formatTargetRefTarget(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return `targetRef ${truncate(value.trim(), 36)}`;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const label = asString(record.name)
    || asString(record.textHint)
    || asString(record.selector)
    || asString(record.refId)
    || 'target';
  const source = asString(record.source) || 'ref';
  const age = formatTargetRefAge(record.capturedAtMs);
  const snapshot = asString(record.snapshotId);
  return [
    truncate(label, 42),
    source,
    age,
    snapshot ? truncate(snapshot, 28) : null,
  ].filter(Boolean).join(' · ');
}

function formatTargetRefAge(capturedAtMs: unknown): string | null {
  if (typeof capturedAtMs !== 'number' || !Number.isFinite(capturedAtMs)) {
    return null;
  }
  const ageMs = Math.max(0, Date.now() - capturedAtMs);
  if (ageMs < 1000) {
    return '<1s old';
  }
  if (ageMs < 60_000) {
    return `${Math.floor(ageMs / 1000)}s old`;
  }
  return `${Math.floor(ageMs / 60_000)}m old`;
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

function formatWindowLocalPoint(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const x = asNumber(record.x);
  const y = asNumber(record.y);
  return x !== null && y !== null ? `windowLocal ${x},${y}` : null;
}

function formatBackgroundWindowTarget(args: Record<string, unknown>, metadata?: Record<string, unknown>): string | null {
  const windowRef = asString(args.windowRef) || asString(metadata?.targetWindowRef);
  if (windowRef) {
    return `windowRef ${truncate(windowRef, 48)}`;
  }

  const pid = asNumber(args.pid) ?? asNumber(metadata?.targetPid);
  const windowId = asNumber(args.windowId) ?? asNumber(metadata?.targetWindowId);
  const windowLocal = formatWindowLocalPoint(args.windowLocalPoint)
    || formatWindowLocalPoint(metadata?.windowLocalPoint);
  const windowX = asNumber(args.windowX);
  const windowY = asNumber(args.windowY);
  const windowPoint = windowLocal || (windowX !== null && windowY !== null ? `windowLocal ${windowX},${windowY}` : null);
  const parts = [
    pid !== null ? `pid ${pid}` : null,
    windowId !== null ? `window ${windowId}` : null,
    windowPoint,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' · ') : null;
}

function hasBackgroundWindowTarget(args: Record<string, unknown>, metadata?: Record<string, unknown>): boolean {
  return !!formatBackgroundWindowTarget(args, metadata);
}

function formatTypedText(args: Record<string, unknown>): string {
  if (asString(args.secretRef)) {
    return 'secretRef';
  }
  const text = asString(args.text);
  return text ? `${text.length} chars` : 'text';
}

function isInputPayloadAction(action: string): boolean {
  return action === 'type'
    || action === 'smart_type'
    || action === 'fill_form'
    || action === 'upload_file'
    || action === 'export_storage_state'
    || action === 'import_storage_state';
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

function getComputerMode(
  args: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  traceMode?: string | null,
): string | null {
  return traceMode
    || asString(metadata?.computerSurfaceMode)
    || asString(args.mode)
    || (metadata?.foregroundFallback ? 'foreground_fallback' : null)
    || (hasBackgroundWindowTarget(args, metadata) ? 'background_cgevent' : null)
    || (metadata?.backgroundSurface ? 'background_ax' : null);
}

function getCatalogRiskLabel(
  catalog: BrowserComputerActionCatalogEntry,
  mode: string | null,
  metadata?: Record<string, unknown>,
): string {
  if (catalog.risk === 'read') {
    return '只读';
  }
  if (catalog.scope === 'managed_browser' || catalog.scope === 'browser_scoped_computer') {
    return '托管浏览器动作';
  }
  if (mode === 'background_cgevent' || metadata?.computerSurfaceMode === 'background_cgevent') {
    return '后台 CGEvent';
  }
  if (mode === 'background_ax' || metadata?.computerSurfaceMode === 'background_ax' || metadata?.backgroundSurface) {
    return '后台 AX';
  }
  return '前台需确认';
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
    case 'get_account_state':
      return { summary: '读取账号态摘要' };
    case 'export_storage_state':
      return { summary: '导出 storageState', target: basename(args.storageStatePath) };
    case 'import_storage_state':
      return { summary: '导入 storageState', target: basename(args.storageStatePath) };
    case 'wait_for_download':
      return { summary: '等待下载完成', target: formatSelector(args) };
    case 'upload_file':
      return { summary: '上传文件', target: basename(args.uploadFilePath) || formatSelector(args) };
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

function buildComputerSummary(action: string, args: Record<string, unknown>, metadata?: Record<string, unknown>, mode?: string | null): {
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
    case 'get_windows':
      return { summary: '读取窗口候选', target: asString(args.targetApp) || asString(args.title) || asString(args.bundleId) };
    case 'diagnose_app':
      return { summary: '诊断目标 app', target: asString(args.targetApp) || asString(args.bundleId) };
    case 'click':
    case 'doubleClick':
    case 'rightClick':
      if (mode === 'background_cgevent' || hasBackgroundWindowTarget(args, metadata)) {
        return {
          summary: `${action} 后台窗口动作`,
          target: formatBackgroundWindowTarget(args, metadata) || asString(args.targetApp) || asString(metadata?.targetApp),
        };
      }
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
  const catalog = getBrowserComputerActionCatalogEntry(toolCall.name, action, args);
  if (!catalog) {
    return null;
  }
  const { traceId, mode } = getTraceMetadata(toolCall);

  if (toolCall.name === 'browser_action') {
    return {
      surface: 'browser',
      tool: catalog.tool,
      action: catalog.action,
      ...buildBrowserSummary(action, args),
      risk: catalog.risk,
      riskLabel: getCatalogRiskLabel(catalog, mode),
      scope: catalog.scope,
      requiresManagedSession: catalog.requiresManagedSession,
      evidenceKind: catalog.evidenceKind,
      approvalKind: catalog.approvalKind,
      safeRecovery: catalog.safeRecovery,
      traceId,
      mode,
    };
  }

  const metadata = toolCall.result?.metadata || {};
  const computerMode = getComputerMode(args, metadata, mode);
  const summary = buildComputerSummary(action, args, metadata, computerMode);
  const metadataTargetApp = asString(metadata.targetApp);
  return {
    surface: 'computer',
    tool: catalog.tool,
    action: catalog.action,
    ...summary,
    target: summary.target || metadataTargetApp,
    risk: catalog.risk,
    riskLabel: getCatalogRiskLabel(catalog, computerMode, metadata),
    scope: catalog.scope,
    requiresManagedSession: catalog.requiresManagedSession,
    evidenceKind: catalog.evidenceKind,
    approvalKind: catalog.approvalKind,
    safeRecovery: catalog.safeRecovery,
    traceId,
    mode: computerMode,
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

function formatComputerSurfaceStateSummary(surface: { ready?: unknown; mode?: unknown } | undefined): string | null {
  if (!surface) {
    return null;
  }

  const mode = asString(surface.mode) || 'unknown';
  if (mode === 'foreground_fallback') {
    return 'Computer Surface: foreground fallback · foreground required';
  }

  return `Computer Surface: ${surface.ready ? 'ready' : 'not ready'} · ${mode}`;
}

function formatAccountStateSummary(value: unknown, prefix = '账号态'): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = asString(value.status) || 'empty';
  const cookieCount = asNumber(value.cookieCount) ?? 0;
  const originCount = asNumber(value.originCount) ?? 0;
  const localStorageEntryCount = asNumber(value.localStorageEntryCount) ?? 0;
  const expiredCookieCount = asNumber(value.expiredCookieCount) ?? 0;
  return [
    `${prefix}: ${status}`,
    `${cookieCount} cookies`,
    `${originCount} origins`,
    `${localStorageEntryCount} localStorage`,
    expiredCookieCount > 0 ? `${expiredCookieCount} expired` : null,
  ].filter(Boolean).join(' · ');
}

function formatArtifactSummary(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = asString(value.kind) || 'artifact';
  const name = asString(value.name) || asString(value.artifactPath) || 'artifact';
  const size = asNumber(value.size);
  const sha256 = asString(value.sha256);
  return [
    kind === 'download' ? '下载完成' : kind === 'upload' ? '上传文件已选择' : 'Artifact',
    name,
    size !== null ? `${size} bytes` : null,
    sha256 ? `sha256 ${truncate(sha256, 15)}` : null,
  ].filter(Boolean).join(' · ');
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
        const interactive = countArray((metadata.domSnapshot as Record<string, unknown> | undefined)?.interactiveElements)
          ?? countArray((metadata.domSnapshot as Record<string, unknown> | undefined)?.interactive);
        if (headings !== null || interactive !== null) {
          return `DOM snapshot: ${headings ?? 0} headings · ${interactive ?? 0} interactive`;
        }
        return 'DOM snapshot 已读取';
      }
      case 'get_a11y_snapshot':
        return 'Accessibility snapshot 已读取';
      case 'get_workbench_state':
        return 'Browser workbench state 已读取';
      case 'get_account_state':
        return formatAccountStateSummary(metadata.browserAccountState) || '账号态摘要已读取';
      case 'export_storage_state':
        return formatAccountStateSummary(metadata.browserAccountState, 'Storage state 已导出') || joinResultSummary(preview);
      case 'import_storage_state':
        return formatAccountStateSummary(metadata.browserAccountState, 'Storage state 已导入') || joinResultSummary(preview);
      case 'wait_for_download':
      case 'upload_file':
        return formatArtifactSummary(metadata.browserArtifact) || joinResultSummary(preview);
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
      return formatComputerSurfaceStateSummary(surface) || joinResultSummary(preview);
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
  if ('secretRef' in safeArgs) {
    safeArgs.secretRef = '[secretRef]';
    safeArgs.secretScope = summarizeBrowserComputerSecretScope(args);
    delete safeArgs.domainScope;
    delete safeArgs.secretDomain;
    delete safeArgs.secretDomains;
    delete safeArgs.legacyGlobalSecret;
  }
  if ('uploadFilePath' in safeArgs) {
    safeArgs.uploadFilePath = basename(safeArgs.uploadFilePath);
  }
  if ('storageStatePath' in safeArgs) {
    safeArgs.storageStatePath = basename(safeArgs.storageStatePath);
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
