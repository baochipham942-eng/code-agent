import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  PlugZap,
  ShieldCheck,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type {
  AgentPointerEvent,
  BrowserCookieImportResult,
  BrowserProfileDescriptor,
  ManagedBrowserAccountStateSummary,
  ManagedBrowserExternalBridgeState,
  ManagedBrowserSessionState,
} from '@shared/contract/desktop';
import { useComposerStore } from '../../../stores/composerStore';
import { useWorkbenchBrowserSession } from '../../../hooks/useWorkbenchBrowserSession';
import { useLiveAgentPointer } from '../../../hooks/useLiveAgentPointer';
import { buildBrowserWorkbenchStatusRows } from '../../../utils/workbenchPresentation';
import ipcService from '../../../services/ipcService';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { AgentPointerPreviewCard, AgentPointerTimelineList } from '../../workbench/AgentPointerOverlay';

interface BrowserSurfacePanelProps {
  onClose: () => void;
}

interface AccountRefreshResult {
  accountState: ManagedBrowserAccountStateSummary;
  session: ManagedBrowserSessionState;
}

type BusyAction =
  | 'open'
  | 'launch'
  | 'refresh'
  | 'close'
  | 'startRelay'
  | 'stopRelay'
  | 'openExtension'
  | 'listProfiles'
  | 'importProfile'
  | 'clearCookies';

interface ProfileImportIpcResult {
  result: BrowserCookieImportResult;
  session: ManagedBrowserSessionState;
}

interface AccountClearResult {
  accountState: ManagedBrowserAccountStateSummary;
  session: ManagedBrowserSessionState;
}

function summarizeProfilePath(profileDir: string): string {
  if (!profileDir) return '—';
  const parts = profileDir.split(/[/\\]/).filter(Boolean);
  return parts.slice(-3).join('/') || profileDir;
}

function getBridgeLabel(bridge: ManagedBrowserExternalBridgeState | null | undefined): string {
  if (!bridge) return '未知';
  switch (bridge.status) {
    case 'connected':
      return '已连接';
    case 'listening':
      return '等待扩展';
    case 'stopped':
      return '未启动';
    case 'error':
      return '异常';
    case 'unsupported':
    default:
      return '不可用';
  }
}

function getStatusClass(ready: boolean): string {
  return ready ? 'text-emerald-300' : 'text-amber-300';
}

export const BrowserSurfacePanel: React.FC<BrowserSurfacePanelProps> = ({ onClose }) => {
  const setBrowserSessionMode = useComposerStore((state) => state.setBrowserSessionMode);
  const browserSession = useWorkbenchBrowserSession();
  const [url, setUrl] = useState('https://www.google.com/');
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<BrowserProfileDescriptor[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [selectedProfileKey, setSelectedProfileKey] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<BrowserCookieImportResult | null>(null);
  const livePointer = useLiveAgentPointer('browser');

  const managedRows = useMemo(
    () => buildBrowserWorkbenchStatusRows({ mode: 'managed', browserSession }),
    [browserSession],
  );
  const accountState = browserSession.managedSession.accountState || browserSession.preview?.accountState || null;
  const bridge = browserSession.managedSession.externalBridge || browserSession.preview?.externalBridge || null;

  const run = useCallback(async (action: BusyAction, fn: () => Promise<void>) => {
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await browserSession.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyAction(null);
    }
  }, [browserSession]);

  const handleOpen = useCallback(() => run('open', async () => {
    setBrowserSessionMode('managed');
    await ipcService.invokeDomain<ManagedBrowserSessionState>(
      IPC_DOMAINS.DESKTOP,
      'openManagedBrowserUrl',
      { url, mode: 'visible', profileMode: 'isolated' },
    );
    setNotice('已在本次隔离的托管浏览器打开。关闭后会清理临时 profile。');
  }), [run, setBrowserSessionMode, url]);

  const handleLaunch = useCallback(() => run('launch', async () => {
    setBrowserSessionMode('managed');
    await ipcService.invokeDomain<ManagedBrowserSessionState>(
      IPC_DOMAINS.DESKTOP,
      'ensureManagedBrowserSession',
      { mode: 'visible', profileMode: 'isolated' },
    );
    setNotice('托管浏览器已启动。');
  }), [run, setBrowserSessionMode]);

  const handleRefreshAccount = useCallback(() => run('refresh', async () => {
    await ipcService.invokeDomain<AccountRefreshResult>(
      IPC_DOMAINS.DESKTOP,
      'refreshManagedBrowserAccountState',
    );
    setNotice('账号状态摘要已刷新。');
  }), [run]);

  const handleCloseBrowser = useCallback(() => run('close', async () => {
    await ipcService.invokeDomain<ManagedBrowserSessionState>(
      IPC_DOMAINS.DESKTOP,
      'closeManagedBrowserSession',
    );
    setNotice('托管浏览器已关闭，隔离 profile 已进入清理。');
  }), [run]);

  const handleStartRelay = useCallback(() => run('startRelay', async () => {
    await ipcService.invokeDomain<ManagedBrowserExternalBridgeState>(
      IPC_DOMAINS.DESKTOP,
      'startBrowserRelay',
    );
    setNotice('本机 Chrome Relay 已启动。');
  }), [run]);

  const handleStopRelay = useCallback(() => run('stopRelay', async () => {
    await ipcService.invokeDomain<ManagedBrowserExternalBridgeState>(
      IPC_DOMAINS.DESKTOP,
      'stopBrowserRelay',
    );
    setNotice('本机 Chrome Relay 已停止。');
  }), [run]);

  const handleOpenExtension = useCallback(() => run('openExtension', async () => {
    await ipcService.invokeDomain<ManagedBrowserExternalBridgeState>(
      IPC_DOMAINS.DESKTOP,
      'openBrowserRelayExtensionDirectory',
    );
    setNotice('已打开扩展目录。Chrome 里用「加载已解压的扩展程序」选择这个目录。');
  }), [run]);

  const handleListProfiles = useCallback(() => run('listProfiles', async () => {
    const list = await ipcService.invokeDomain<BrowserProfileDescriptor[]>(
      IPC_DOMAINS.DESKTOP,
      'listBrowserProfiles',
    );
    setProfiles(Array.isArray(list) ? list : []);
    setProfilesLoaded(true);
    const firstAvailable = (Array.isArray(list) ? list : []).find((item) => item.available);
    if (firstAvailable) {
      setSelectedProfileKey(`${firstAvailable.source}::${firstAvailable.profileId}`);
    }
    setNotice(`已扫描 ${Array.isArray(list) ? list.length : 0} 个浏览器 profile（macOS Chromium 系）。`);
  }), [run]);

  const handleImportProfile = useCallback(() => run('importProfile', async () => {
    const selected = profiles.find((item) => `${item.source}::${item.profileId}` === selectedProfileKey);
    if (!selected) {
      throw new Error('请先选择一个可导入的浏览器 profile。');
    }
    if (!selected.available) {
      throw new Error(selected.unavailableMessage || '该 profile 当前不可用。');
    }
    setBrowserSessionMode('managed');
    const response = await ipcService.invokeDomain<ProfileImportIpcResult>(
      IPC_DOMAINS.DESKTOP,
      'importBrowserProfileCookies',
      {
        source: selected.source,
        profileId: selected.profileId,
        userConfirmed: true,
      },
    );
    const result = response?.result;
    setLastImport(result || null);
    if (!result?.ok) {
      throw new Error(
        result?.failureMessage
        || 'Cookie 导入失败。可改用 Chrome Relay 附着已登录标签。',
      );
    }
    setNotice(
      `已从 ${selected.appName} / ${selected.profileName} 导入 ${result.importedCookieCount} 条 Cookie`
      + (result.domainCount ? `（${result.domainCount} 个 domain）` : '')
      + '。托管浏览器已 reload。',
    );
  }), [profiles, run, selectedProfileKey, setBrowserSessionMode]);

  const handleClearCookies = useCallback(() => run('clearCookies', async () => {
    await ipcService.invokeDomain<AccountClearResult>(
      IPC_DOMAINS.DESKTOP,
      'clearManagedBrowserCookies',
    );
    setLastImport(null);
    setNotice('已清除托管浏览器 Cookie。');
  }), [run]);

  useEffect(() => {
    // Load profile catalog once when surface opens; failures stay quiet until user clicks refresh.
    void ipcService.invokeDomain<BrowserProfileDescriptor[]>(
      IPC_DOMAINS.DESKTOP,
      'listBrowserProfiles',
    ).then((list) => {
      setProfiles(Array.isArray(list) ? list : []);
      setProfilesLoaded(true);
      const firstAvailable = (Array.isArray(list) ? list : []).find((item) => item.available);
      if (firstAvailable) {
        setSelectedProfileKey(`${firstAvailable.source}::${firstAvailable.profileId}`);
      }
    }).catch(() => {
      setProfilesLoaded(true);
    });
  }, []);

  const availableProfiles = useMemo(
    () => profiles.filter((item) => item.available),
    [profiles],
  );

  const isBusy = (action: BusyAction) => busyAction === action;
  const bridgeReady = bridge?.status === 'connected';
  const browserReady = browserSession.managedSession.running;
  const lastTracePointer = browserSession.managedSession.lastTrace?.agentPointerEvent || null;
  const pointerPreview = useMemo<AgentPointerEvent>(() => ({
    ...(livePointer.event || livePointer.lastEvent || lastTracePointer || {
    id: 'browser-surface-pointer-preview',
    surface: 'browser',
    tone: browserReady ? 'browser' : 'idle',
    phase: browserReady ? 'click' : 'preview',
    coordSpace: 'surfacePreview',
    point: { x: browserReady ? 38 : 34, y: browserReady ? 42 : 38, unit: 'percent' },
    targetLabel: browserReady
      ? browserSession.managedSession.activeTab?.title || browserSession.managedSession.activeTab?.url || 'active tab'
      : 'launch browser',
    targetSource: 'fallback',
    traceId: browserSession.managedSession.lastTrace?.id || null,
    success: browserReady,
    }),
  }), [browserReady, browserSession.managedSession.activeTab?.title, browserSession.managedSession.activeTab?.url, browserSession.managedSession.lastTrace?.id, lastTracePointer, livePointer.event, livePointer.lastEvent]);

  return (
    <FullScreenPage testId="browser-surface-panel">
      <FullScreenPageHeader
        icon={<Globe className="h-4 w-4 text-sky-300" />}
        title="Browser Surface"
        description="托管浏览器登录态、本机 profile Cookie 导入，以及 Chrome Relay（ADR-041）"
        onClose={onClose}
        closeLabel="关闭 Browser Surface"
      />

        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
            <section className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-zinc-200">托管浏览器</div>
                  <div className="text-[11px] text-zinc-500">System Chrome CDP + run-scoped isolated profile</div>
                </div>
                <span className={`text-xs ${getStatusClass(browserReady)}`}>
                  {browserReady ? 'Running' : 'Stopped'}
                </span>
              </div>

              <div className="flex gap-2">
                <input
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleOpen();
                    }
                  }}
                  className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-hidden transition-colors placeholder:text-zinc-600 focus:border-sky-400/40"
                  placeholder="https://example.com"
                />
                <button
                  type="button"
                  onClick={handleOpen}
                  disabled={Boolean(busyAction)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/15 px-3 py-2 text-sm text-sky-200 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isBusy('open') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                  打开
                </button>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                <BrowserActionButton busy={isBusy('launch')} disabled={Boolean(busyAction)} onClick={handleLaunch}>
                  启动 Visible
                </BrowserActionButton>
                <BrowserActionButton busy={isBusy('refresh')} disabled={Boolean(busyAction) || !browserReady} onClick={handleRefreshAccount}>
                  刷新账号摘要
                </BrowserActionButton>
                <BrowserActionButton busy={isBusy('close')} disabled={Boolean(busyAction) || !browserReady} onClick={handleCloseBrowser}>
                  关闭浏览器
                </BrowserActionButton>
              </div>

              <div className="mt-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                {managedRows.length > 0 ? managedRows.map((row) => (
                  <div key={row.label} className="grid min-w-0 grid-cols-[72px,minmax(0,1fr)] gap-2 text-[11px]">
                    <span className="text-zinc-500">{row.label}</span>
                    <span className={`truncate ${row.tone === 'ready' ? 'text-emerald-300' : row.tone === 'blocked' ? 'text-amber-300' : 'text-zinc-300'}`} title={row.title || row.value}>
                      {row.value}
                    </span>
                  </div>
                )) : (
                  <div className="text-[11px] text-zinc-500">还没有浏览器 session。</div>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <PlugZap className="h-3.5 w-3.5 text-violet-300" />
                    Chrome Relay
                  </div>
                  <div className="text-[11px] text-zinc-500">接真实 Chrome 标签页和现有登录态</div>
                </div>
                <span className={`text-xs ${getStatusClass(bridgeReady)}`}>{getBridgeLabel(bridge)}</span>
              </div>

              <div className="space-y-1.5 text-[11px]">
                <InfoRow label="Port" value={bridge?.port ? String(bridge.port) : '未启动'} />
                <InfoRow label="Token" value={bridge?.tokenHint || '未生成'} />
                <InfoRow label="Extension" value={bridge?.extensionPath ? '已打包' : '未找到'} title={bridge?.extensionPath || undefined} />
                <InfoRow label="Leased" value={String(bridge?.attachedTabCount || 0)} />
              </div>

              {bridge?.reason && (
                <div className="mt-2 rounded-md border border-white/[0.06] bg-black/10 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-500">
                  {bridge.reason}
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5">
                <BrowserActionButton busy={isBusy('startRelay')} disabled={Boolean(busyAction)} onClick={handleStartRelay}>
                  启动 Relay
                </BrowserActionButton>
                <BrowserActionButton busy={isBusy('openExtension')} disabled={Boolean(busyAction) || !bridge?.extensionPath} onClick={handleOpenExtension}>
                  打开扩展目录
                </BrowserActionButton>
                <BrowserActionButton busy={isBusy('stopRelay')} disabled={Boolean(busyAction) || bridge?.status === 'stopped'} onClick={handleStopRelay}>
                  停止
                </BrowserActionButton>
              </div>

              <div className="mt-3 rounded-md border border-white/[0.06] bg-black/10 px-2 py-2 text-[11px] leading-relaxed text-zinc-500">
                向导：1) 启动 Relay → 2) Chrome 加载扩展 → 3) Agent 请求 Relay lease → 4) 只在扩展 popup 中选择当前 tab，并确认 domain、action 和有效期。Neo 不会列出你的其他标签或拿到原生 tab id。
              </div>
            </section>

            <section className="lg:col-span-2 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <KeyRound className="h-3.5 w-3.5 text-amber-300" />
                    复用浏览器登录
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    从本机 Chrome / Edge / Brave / Arc… 导入 Cookie 到托管浏览器（需 Keychain 授权，不落 cookie value）
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <BrowserActionButton busy={isBusy('listProfiles')} disabled={Boolean(busyAction)} onClick={handleListProfiles}>
                    刷新 profile 列表
                  </BrowserActionButton>
                  <BrowserActionButton
                    busy={isBusy('importProfile')}
                    disabled={Boolean(busyAction) || !selectedProfileKey}
                    onClick={handleImportProfile}
                  >
                    导入选中 profile
                  </BrowserActionButton>
                  <BrowserActionButton
                    busy={isBusy('clearCookies')}
                    disabled={Boolean(busyAction)}
                    onClick={handleClearCookies}
                  >
                    清除托管 Cookie
                  </BrowserActionButton>
                </div>
              </div>

              {!profilesLoaded ? (
                <div className="text-[11px] text-zinc-500">正在扫描本机浏览器 profile…</div>
              ) : availableProfiles.length === 0 ? (
                <div className="text-[11px] text-zinc-500">
                  未发现可用 Chromium profile。请确认已安装并运行过对应浏览器，或改用 Chrome Relay。
                </div>
              ) : (
                <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
                  {availableProfiles.map((profile) => {
                    const key = `${profile.source}::${profile.profileId}`;
                    const selected = key === selectedProfileKey;
                    return (
                      <label
                        key={key}
                        className={`flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 text-[11px] transition-colors ${
                          selected
                            ? 'border-amber-400/40 bg-amber-500/10 text-zinc-100'
                            : 'border-white/[0.06] bg-black/10 text-zinc-300 hover:border-white/[0.12]'
                        }`}
                      >
                        <input
                          type="radio"
                          name="browser-profile"
                          className="mt-0.5"
                          checked={selected}
                          onChange={() => setSelectedProfileKey(key)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium text-zinc-100">
                            {profile.appName}
                            {' · '}
                            {profile.profileName}
                          </span>
                          <span className="mt-0.5 block truncate text-zinc-500" title={profile.profileDir}>
                            {summarizeProfilePath(profile.profileDir)}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}

              {lastImport && (
                <div className="mt-2 rounded-md border border-white/[0.06] bg-black/10 px-2 py-1.5 text-[11px] text-zinc-400">
                  上次导入：
                  {lastImport.ok
                    ? `${lastImport.importedCookieCount} cookies / ${lastImport.domainCount} domains`
                    : (lastImport.failureMessage || lastImport.failureCode || 'failed')}
                  {lastImport.ok && lastImport.domains.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {lastImport.domains.slice(0, 10).map((domain) => (
                        <span key={domain} className="rounded border border-white/[0.06] px-1.5 py-0.5 text-zinc-300">
                          {domain}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              )}
            </section>

            <section className="lg:col-span-2">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
                <AgentPointerPreviewCard
                  event={pointerPreview}
                  title="Agent pointer"
                  detail="Browser actions use the same visible pointer in trace rows and screenshot previews."
                  live={livePointer.isLive || !livePointer.lastEvent}
                />
                <AgentPointerTimelineList entries={livePointer.timeline} />
              </div>
            </section>
          </div>

          <section className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              登录态摘要
            </div>
            {accountState ? (
              <div className="grid gap-2 md:grid-cols-[220px_minmax(0,1fr)]">
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <InfoMetric label="Cookies" value={String(accountState.cookieCount)} />
                  <InfoMetric label="Origins" value={String(accountState.originCount)} />
                  <InfoMetric label="LocalStorage" value={String(accountState.localStorageEntryCount)} />
                  <InfoMetric label="Expired" value={String(accountState.expiredCookieCount)} />
                </div>
                <div className="min-w-0 rounded-md border border-white/[0.06] bg-black/10 px-2 py-2 text-[11px] text-zinc-400">
                  {accountState.cookieDomains.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {accountState.cookieDomains.slice(0, 12).map((domain) => (
                        <span key={domain} className="rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5">
                          {domain}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-zinc-500">暂无 cookie domain。登录网站后刷新账号摘要。</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-[11px] text-zinc-500">尚未刷新账号状态摘要。这里不会展示 cookie value 或 token。</div>
            )}
          </section>

          {notice && (
            <div className="mt-3 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
              {notice}
            </div>
          )}
          {error && (
            <div className="mt-3 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
        </div>
    </FullScreenPage>
  );
};

const BrowserActionButton = ({
  busy,
  disabled,
  onClick,
  children,
  icon,
}: {
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-white/[0.16] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
  >
    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : icon}
    {children}
  </button>
);

const InfoRow = ({ label, value, title }: { label: string; value: string; title?: string }) => (
  <div className="grid grid-cols-[72px,minmax(0,1fr)] gap-2">
    <span className="text-zinc-500">{label}</span>
    <span className="truncate text-zinc-300" title={title || value}>{value}</span>
  </div>
);

const InfoMetric = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-md border border-white/[0.06] bg-black/10 px-2 py-1.5">
    <div className="text-[10px] text-zinc-500">{label}</div>
    <div className="mt-0.5 text-sm font-medium tabular-nums text-zinc-200">{value}</div>
  </div>
);

export default BrowserSurfacePanel;
