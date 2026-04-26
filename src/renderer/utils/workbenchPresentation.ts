import type {
  WorkbenchHistoryAction,
  WorkbenchReference,
  WorkbenchSkillCapability,
} from '../hooks/useWorkbenchCapabilities';
import type { BrowserWorkbenchReadinessItem, BrowserWorkbenchState } from '../hooks/useWorkbenchBrowserSession';
import type {
  ManagedBrowserAccountStateSummary,
  ManagedBrowserLeaseState,
  ManagedBrowserProfileMode,
  ManagedBrowserProxyConfig,
} from '@shared/contract/desktop';
import type { BrowserSessionMode } from '@shared/contract/conversationEnvelope';
import type { WorkbenchCapabilityRegistryItem } from './workbenchCapabilityRegistry';

type WorkbenchRuntimeStatus = 'connected' | 'disconnected' | 'connecting' | 'error' | 'lazy';
type Locale = 'en' | 'zh';
type BrowserWorkbenchStateForPresentation = Pick<
  BrowserWorkbenchState,
  | 'managedSession'
  | 'computerSurface'
  | 'preview'
  | 'blocked'
  | 'blockedDetail'
>;

export type BrowserWorkbenchStatusTone = 'ready' | 'blocked' | 'neutral';

export interface BrowserWorkbenchStatusRow {
  label: string;
  value: string;
  tone?: BrowserWorkbenchStatusTone;
  title?: string;
}

const STATUS_LABELS: Record<WorkbenchRuntimeStatus, { en: string; zh: string; colorClass: string }> = {
  connected: {
    en: 'connected',
    zh: '已连接',
    colorClass: 'text-green-400',
  },
  disconnected: {
    en: 'disconnected',
    zh: '未连接',
    colorClass: 'text-zinc-400',
  },
  connecting: {
    en: 'connecting',
    zh: '连接中',
    colorClass: 'text-yellow-400',
  },
  error: {
    en: 'error',
    zh: '错误',
    colorClass: 'text-red-400',
  },
  lazy: {
    en: 'lazy',
    zh: '懒加载',
    colorClass: 'text-sky-400',
  },
};

function getLocaleLabel(locale: Locale, value: { en: string; zh: string }): string {
  return locale === 'zh' ? value.zh : value.en;
}

export function getWorkbenchStatusPresentation(
  status: WorkbenchRuntimeStatus,
  options?: { locale?: Locale },
): { label: string; colorClass: string } {
  const locale = options?.locale || 'en';
  const presentation = STATUS_LABELS[status];
  return {
    label: getLocaleLabel(locale, presentation),
    colorClass: presentation.colorClass,
  };
}

export function getWorkbenchConnectorStatusPresentation(
  connected: boolean,
  options?: { locale?: Locale },
): { label: string; colorClass: string } {
  return getWorkbenchStatusPresentation(connected ? 'connected' : 'disconnected', options);
}

export function formatWorkbenchHistoryActionSummary(
  actions: WorkbenchHistoryAction[],
  options?: { maxActions?: number },
): string | null {
  if (actions.length === 0) {
    return null;
  }

  const maxActions = options?.maxActions ?? 2;
  return actions
    .slice(0, maxActions)
    .map((action) => action.count > 1 ? `${action.label} ${action.count}x` : action.label)
    .join(' · ');
}

export function formatWorkbenchSkillSecondaryText(
  skill: Pick<WorkbenchSkillCapability, 'description' | 'source'>,
  options?: { locale?: Locale },
): string | undefined {
  if (skill.description) {
    return skill.description;
  }

  if (!skill.source) {
    return undefined;
  }

  const locale = options?.locale || 'zh';
  return locale === 'zh' ? `来源: ${skill.source}` : `source: ${skill.source}`;
}

export function getWorkbenchSkillCapabilityTitle(
  skill: Pick<WorkbenchSkillCapability, 'label' | 'description' | 'source' | 'installState'>,
  options?: { locale?: Locale },
): string | undefined {
  const locale = options?.locale || 'zh';
  const parts = [skill.label];
  const secondary = formatWorkbenchSkillSecondaryText(skill, { locale });
  if (secondary) {
    parts.push(secondary);
  }
  if (skill.installState !== 'mounted') {
    parts.push(
      locale === 'zh'
        ? `状态: ${skill.installState === 'available' ? '已安装未挂载' : '当前不可用'}`
        : `status: ${skill.installState === 'available' ? 'installed but not mounted' : 'currently unavailable'}`,
    );
  }
  return parts.join('\n');
}

export function getWorkbenchCapabilityStatusPresentation(
  capability: WorkbenchCapabilityRegistryItem,
  options?: { locale?: Locale },
): { label: string; colorClass: string } {
  const locale = options?.locale || 'en';

  if (capability.kind === 'skill') {
    if (capability.lifecycle.mountState === 'mounted') {
      return {
        label: locale === 'zh' ? '已挂载' : 'mounted',
        colorClass: 'text-green-400',
      };
    }

    if (capability.lifecycle.installState === 'installed') {
      return {
        label: locale === 'zh' ? '已安装未挂载' : 'installed, not mounted',
        colorClass: 'text-amber-400',
      };
    }

    return {
      label: locale === 'zh' ? '当前不可用' : 'unavailable',
      colorClass: 'text-red-400',
    };
  }

  if (capability.kind === 'connector') {
    if (!capability.connected && capability.readiness === 'unchecked') {
      return {
        label: locale === 'zh' ? '待检查' : 'needs check',
        colorClass: 'text-sky-400',
      };
    }

    if (!capability.connected && capability.readiness === 'failed') {
      return {
        label: locale === 'zh' ? '检查失败' : 'check failed',
        colorClass: 'text-red-400',
      };
    }

    return getWorkbenchConnectorStatusPresentation(capability.connected, options);
  }

  return getWorkbenchStatusPresentation(capability.status, options);
}

export function getWorkbenchCapabilityTitle(
  capability: WorkbenchCapabilityRegistryItem,
  options?: { locale?: Locale },
): string | undefined {
  const locale = options?.locale || 'zh';
  const parts = [capability.label];
  const status = getWorkbenchCapabilityStatusPresentation(capability, { locale });

  if (capability.selected) {
    parts.push(locale === 'zh' ? '已加入本次消息范围' : 'selected for this turn');
  }

  if (capability.kind === 'skill') {
    const secondary = formatWorkbenchSkillSecondaryText(capability, { locale });
    if (secondary) {
      parts.push(secondary);
    }
  } else if (capability.kind === 'connector' && capability.detail) {
    parts.push(capability.detail);
  } else if (capability.kind === 'mcp') {
    parts.push(`transport: ${capability.transport}`);
    if (!capability.enabled) {
      parts.push(locale === 'zh' ? '已禁用' : 'disabled');
    }
    if (capability.error) {
      parts.push(capability.error);
    }
  }

  parts.push(`${locale === 'zh' ? '状态' : 'status'}: ${status.label}`);

  if (capability.blockedReason) {
    parts.push(capability.blockedReason.detail);
    parts.push(capability.blockedReason.hint);
  }

  return parts.join('\n');
}

export function getWorkbenchReferenceTitle(
  reference: WorkbenchReference,
  options?: { locale?: Locale },
): string | undefined {
  const locale = options?.locale || 'zh';
  const parts = [
    reference.kind === 'skill' ? reference.description : reference.kind === 'connector' ? reference.detail : undefined,
    reference.kind === 'skill' && reference.source
      ? (locale === 'zh' ? `来源: ${reference.source}` : `source: ${reference.source}`)
      : undefined,
    reference.kind === 'mcp' ? `transport: ${reference.transport}` : undefined,
    reference.kind === 'skill' && !reference.mounted && reference.installState === 'available'
      ? (locale === 'zh' ? '当前已安装但未挂载' : 'installed but not mounted')
      : undefined,
    reference.kind === 'skill' && !reference.mounted && reference.installState === 'missing'
      ? (locale === 'zh' ? '本轮调用过，但当前共享能力模型里没有对应安装信息' : 'invoked in this turn but missing from the shared capability model')
      : undefined,
    reference.kind === 'connector' && !reference.connected
      ? (locale === 'zh' ? '本轮调用过，但当前未连接' : 'invoked in this turn but currently disconnected')
      : undefined,
    reference.kind === 'mcp' && reference.status !== 'connected'
      ? `${locale === 'zh' ? '当前状态' : 'status'}: ${getWorkbenchStatusPresentation(reference.status, { locale }).label}`
      : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join('\n') : undefined;
}

export function getWorkbenchReferenceBadge(
  reference: WorkbenchReference,
  options?: { locale?: Locale },
): string | null {
  const locale = options?.locale || 'zh';
  if (reference.kind === 'skill' && !reference.mounted) {
    if (reference.installState === 'available') {
      return locale === 'zh' ? '可挂载' : 'mountable';
    }
    return locale === 'zh' ? '调用' : 'invoked';
  }
  if (reference.kind === 'connector') {
    return 'Connector';
  }
  if (reference.kind === 'mcp') {
    return 'MCP';
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function firstStringField(value: unknown, keys: string[]): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const field = record[key];
    if (typeof field === 'string' && field.trim()) {
      return field.trim();
    }
  }
  return null;
}

function getPathBasename(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || normalized || null;
}

function summarizePathTail(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  const basename = getPathBasename(trimmed);
  if (!trimmed || !basename) {
    return null;
  }
  return basename === trimmed ? basename : `.../${basename}`;
}

function getProfileMode(value: unknown): ManagedBrowserProfileMode | null {
  return value === 'persistent' || value === 'isolated' ? value : null;
}

function summarizeWorkspaceScope(value: unknown): string | null {
  if (typeof value === 'string') {
    return summarizePathTail(value) || value.trim() || null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const label = firstStringField(record, ['label', 'name', 'id']);
  if (label) {
    return label;
  }

  return summarizePathTail(firstStringField(record, ['path', 'root', 'cwd', 'workingDirectory']));
}

function buildManagedBrowserProfileValue(preview: unknown, session: unknown): string | null {
  const profileDir = firstStringField(session, ['profileDir']);
  const profileMode = getProfileMode(firstStringField(preview, ['profileMode']) || firstStringField(session, ['profileMode']))
    || (profileDir ? 'persistent' : null);
  const profileId = firstStringField(preview, ['profileId'])
    || firstStringField(session, ['profileId'])
    || getPathBasename(profileDir);
  const profileSummary = firstStringField(preview, ['profileDirSummary'])
    || summarizePathTail(profileDir);

  if (profileMode && profileId) {
    return `${profileMode} / ${profileId}`;
  }
  if (profileMode && profileSummary) {
    return `${profileMode} / ${profileSummary}`;
  }
  if (profileMode) {
    return profileMode;
  }
  return profileId || profileSummary;
}

function buildManagedBrowserScopeValue(preview: unknown, session: unknown): string | null {
  const artifactSummary = firstStringField(preview, ['artifactDirSummary'])
    || summarizePathTail(firstStringField(session, ['artifactDir', 'artifactsDir', 'artifactDirectory', 'artifactRoot']));
  if (artifactSummary) {
    return `artifact: ${artifactSummary}`;
  }

  const sessionRecord = asRecord(session);
  const workspaceSummary = firstStringField(preview, ['workspaceScopeSummary'])
    || summarizeWorkspaceScope(sessionRecord?.workspaceScope)
    || summarizePathTail(firstStringField(session, ['workspaceScope', 'workspaceRoot', 'workspaceDir', 'workingDirectory']));
  return workspaceSummary ? `workspace: ${workspaceSummary}` : null;
}

function getAccountState(preview: unknown, session: unknown): ManagedBrowserAccountStateSummary | null {
  const previewRecord = asRecord(preview);
  const sessionRecord = asRecord(session);
  const value = previewRecord?.accountState || sessionRecord?.accountState;
  return asRecord(value) ? value as unknown as ManagedBrowserAccountStateSummary : null;
}

function buildManagedBrowserAccountValue(accountState: ManagedBrowserAccountStateSummary | null): string | null {
  if (!accountState) {
    return null;
  }
  return [
    accountState.status,
    `${accountState.cookieCount || 0} cookies`,
    `${accountState.originCount || 0} origins`,
    accountState.expiredCookieCount > 0 ? `${accountState.expiredCookieCount} expired` : null,
  ].filter(Boolean).join(' / ');
}

function getManagedBrowserLease(preview: unknown, session: unknown): ManagedBrowserLeaseState | null {
  const value = asRecord(preview)?.lease || asRecord(session)?.lease;
  return asRecord(value) ? value as unknown as ManagedBrowserLeaseState : null;
}

function buildManagedBrowserLeaseValue(lease: ManagedBrowserLeaseState | null): string | null {
  if (!lease) {
    return null;
  }
  const secondsLeft = Math.max(0, Math.ceil((lease.expiresAtMs - Date.now()) / 1000));
  return lease.status === 'active'
    ? `${lease.status} / ${secondsLeft}s / ${lease.owner}`
    : `${lease.status} / ${lease.owner}`;
}

function getManagedBrowserProxy(preview: unknown, session: unknown): ManagedBrowserProxyConfig | null {
  const value = asRecord(preview)?.proxy || asRecord(session)?.proxy;
  return asRecord(value) ? value as unknown as ManagedBrowserProxyConfig : null;
}

function buildManagedBrowserProxyValue(proxy: ManagedBrowserProxyConfig | null): string | null {
  if (!proxy) {
    return null;
  }
  if (proxy.mode === 'direct') {
    return proxy.regionHint ? `direct / ${proxy.regionHint}` : 'direct';
  }
  const bypass = proxy.bypass.length > 0 ? ` / bypass ${proxy.bypass.length}` : '';
  const region = proxy.regionHint ? ` / ${proxy.regionHint}` : '';
  return `${proxy.mode}${region}${bypass}`;
}

export function buildBrowserWorkbenchStatusRows(args: {
  mode: BrowserSessionMode;
  browserSession: BrowserWorkbenchStateForPresentation | null | undefined;
}): BrowserWorkbenchStatusRow[] {
  const { browserSession, mode } = args;
  if (!browserSession || mode === 'none') {
    return [];
  }

  if (mode === 'managed') {
    const preview = browserSession.preview?.mode === 'managed' ? browserSession.preview : null;
    const traceId = preview?.traceId || browserSession.managedSession.lastTrace?.id || null;
    const tabTitle = preview?.title || browserSession.managedSession.activeTab?.title || null;
    const tabUrl = preview?.url || browserSession.managedSession.activeTab?.url || null;
    const sessionId = firstStringField(preview, ['sessionId'])
      || firstStringField(browserSession.managedSession, ['sessionId', 'id']);
    const profileValue = buildManagedBrowserProfileValue(preview, browserSession.managedSession);
    const scopeValue = buildManagedBrowserScopeValue(preview, browserSession.managedSession);
    const accountValue = buildManagedBrowserAccountValue(getAccountState(preview, browserSession.managedSession));
    const lease = getManagedBrowserLease(preview, browserSession.managedSession);
    const leaseValue = buildManagedBrowserLeaseValue(lease);
    const proxyValue = buildManagedBrowserProxyValue(getManagedBrowserProxy(preview, browserSession.managedSession));

    return [
      {
        label: 'Status',
        value: browserSession.managedSession.running ? 'Running' : 'Stopped',
        tone: browserSession.managedSession.running ? 'ready' : 'blocked',
      },
      ...(sessionId
        ? [{
            label: 'Session',
            value: sessionId,
            title: sessionId,
          }]
        : []),
      {
        label: 'Mode',
        value: preview?.surfaceMode || browserSession.managedSession.mode || 'headless',
      },
      ...(profileValue
        ? [{
            label: 'Profile',
            value: profileValue,
            title: profileValue,
          }]
        : []),
      ...(scopeValue
        ? [{
            label: 'Scope',
            value: scopeValue,
            title: scopeValue,
          }]
        : []),
      ...(accountValue
        ? [{
            label: 'Account',
            value: accountValue,
            title: accountValue,
            tone: accountValue.startsWith('account_state_expired') ? 'blocked' as const : 'ready' as const,
          }]
        : []),
      ...(leaseValue
        ? [{
            label: 'Lease',
            value: leaseValue,
            title: leaseValue,
            tone: lease?.status === 'active' ? 'ready' as const : 'blocked' as const,
          }]
        : []),
      ...(proxyValue
        ? [{
            label: 'Proxy',
            value: proxyValue,
            title: proxyValue,
            tone: 'neutral' as const,
          }]
        : []),
      ...(tabTitle || tabUrl
        ? [{
            label: 'Tab',
            value: tabTitle || tabUrl || '',
            title: tabUrl || tabTitle || undefined,
          }]
        : []),
      ...(traceId
        ? [{
            label: 'Trace',
            value: traceId,
            title: traceId,
          }]
        : []),
    ];
  }

  const preview = browserSession.preview?.mode === 'desktop' ? browserSession.preview : null;
  const traceId = preview?.traceId || browserSession.computerSurface?.lastAction?.id || null;
  const surfaceValue = browserSession.computerSurface?.background
    ? 'Background Accessibility surface'
    : browserSession.computerSurface?.mode === 'foreground_fallback'
      ? 'Foreground fallback (current window)'
      : 'Unavailable';

  return [
    {
      label: 'Surface',
      value: surfaceValue,
      tone: browserSession.computerSurface?.ready ? 'ready' : 'blocked',
      title: browserSession.computerSurface?.safetyNote || undefined,
    },
    ...(preview?.frontmostApp || browserSession.computerSurface?.targetApp
      ? [{
          label: 'App',
          value: preview?.frontmostApp || browserSession.computerSurface?.targetApp || '',
        }]
      : []),
    ...(preview?.title
      ? [{
          label: 'Window',
          value: preview.title,
          title: preview.url || preview.title,
        }]
      : []),
    ...(preview?.url
      ? [{
          label: 'URL',
          value: preview.url,
          title: preview.url,
        }]
      : []),
    ...(traceId
      ? [{
          label: 'Trace',
          value: traceId,
          title: traceId,
        }]
      : []),
  ];
}

export function getBrowserWorkbenchOperationalHint(args: {
  mode: BrowserSessionMode;
  browserSession: BrowserWorkbenchStateForPresentation | null | undefined;
}): string | null {
  const { browserSession, mode } = args;
  if (!browserSession || mode === 'none') {
    return null;
  }

  if (browserSession.blockedDetail) {
    return browserSession.blockedDetail;
  }

  if (mode === 'managed') {
    return browserSession.managedSession.running
      ? 'browser_action 会使用托管浏览器。'
      : '托管浏览器未启动。';
  }

  if (browserSession.computerSurface?.background) {
    return browserSession.computerSurface.safetyNote || 'computer_use 会通过 macOS Accessibility 操作指定 app/window。';
  }

  if (browserSession.computerSurface?.mode === 'foreground_fallback') {
    return browserSession.computerSurface.safetyNote || 'computer_use 会作用于当前前台 app/window；没有后台隔离，高风险动作仍走确认。';
  }

  return 'Computer Surface 当前不可用。';
}

export function getBrowserWorkbenchReadinessTone(
  item: Pick<BrowserWorkbenchReadinessItem, 'ready' | 'tone'>,
): BrowserWorkbenchStatusTone {
  return item.tone || (item.ready ? 'ready' : 'blocked');
}
