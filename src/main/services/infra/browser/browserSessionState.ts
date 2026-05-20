import type {
  ManagedBrowserAccountStateSummary,
  ManagedBrowserExternalBridgeState,
  ManagedBrowserLeaseState,
  ManagedBrowserMode,
  ManagedBrowserProfileMode,
  ManagedBrowserProxyConfig,
  ManagedBrowserSessionState,
  WorkbenchActionTrace,
  WorkbenchSnapshotRef,
} from '../../../../shared/contract/desktop';
import type {
  BrowserProviderDiagnostics,
  BrowserTab,
} from './types';

export function buildManagedBrowserSessionState(args: {
  sessionId: string | null;
  profileId: string;
  profileMode: ManagedBrowserProfileMode;
  workspaceScope: string;
  artifactDir: string;
  lease: ManagedBrowserLeaseState | null;
  proxy: ManagedBrowserProxyConfig;
  externalBridge: ManagedBrowserExternalBridgeState;
  accountState: ManagedBrowserAccountStateSummary | null;
  running: boolean;
  tabCount: number;
  activeTab: BrowserTab | null;
  mode: ManagedBrowserMode;
  providerDiagnostics: BrowserProviderDiagnostics;
  profileDir: string;
  viewport: { width: number; height: number };
  allowedHosts: string[];
  blockedHosts: string[];
  lastTrace: WorkbenchActionTrace | null;
}): ManagedBrowserSessionState {
  return {
    sessionId: args.sessionId,
    profileId: args.profileId,
    profileMode: args.profileMode,
    workspaceScope: args.workspaceScope,
    artifactDir: args.artifactDir,
    lease: args.lease,
    proxy: {
      ...args.proxy,
      bypass: [...args.proxy.bypass],
    },
    externalBridge: args.externalBridge,
    accountState: args.accountState,
    running: args.running,
    tabCount: args.tabCount,
    activeTab: args.activeTab
      ? {
        id: args.activeTab.id,
        url: args.activeTab.url,
        title: args.activeTab.title,
      }
      : null,
    mode: args.mode,
    provider: args.providerDiagnostics.provider,
    requestedProvider: args.providerDiagnostics.requestedProvider,
    executable: args.providerDiagnostics.executable,
    cdpPort: args.providerDiagnostics.cdpPort,
    profileDir: args.profileDir,
    missingExecutable: args.providerDiagnostics.missingExecutable,
    recommendedAction: args.providerDiagnostics.recommendedAction,
    providerFallbackReason: args.providerDiagnostics.providerFallbackReason,
    viewport: args.viewport,
    allowedHosts: args.allowedHosts,
    blockedHosts: args.blockedHosts,
    lastTrace: args.lastTrace,
  };
}

export function snapshotBrowserTab(
  tab: BrowserTab | null,
  screenshotPath?: string,
): WorkbenchSnapshotRef | null {
  if (!tab) {
    return null;
  }

  return {
    url: tab.url,
    title: tab.title,
    screenshotPath: screenshotPath || null,
    capturedAtMs: Date.now(),
  };
}
