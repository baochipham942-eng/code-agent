// ============================================================================
// Desktop Activity Types - 原生桌面活动采集与查询
// ============================================================================

export interface DesktopActivityEvent {
  id: string;
  capturedAtMs: number;
  appName: string;
  bundleId?: string | null;
  windowTitle?: string | null;
  browserUrl?: string | null;
  browserTitle?: string | null;
  documentPath?: string | null;
  sessionState?: string | null;
  idleSeconds?: number | null;
  powerSource?: string | null;
  onAcPower?: boolean | null;
  batteryPercent?: number | null;
  batteryCharging?: boolean | null;
  screenshotPath?: string | null;
  analyzeText?: string | null;
  fingerprint: string;
}

export interface DesktopCollectorStatus {
  running: boolean;
  phase: string;
  intervalSecs: number;
  captureScreenshots: boolean;
  redactSensitiveContexts?: boolean | null;
  retentionDays?: number | null;
  dedupeWindowSecs: number;
  maxRecentEvents: number;
  lastEventAtMs?: number | null;
  lastCleanupAtMs?: number | null;
  lastError?: string | null;
  lastFingerprint?: string | null;
  totalEventsWritten: number;
  eventDir?: string | null;
  screenshotDir?: string | null;
  eventsFile?: string | null;
  sqliteDbPath?: string | null;
}

export interface ManagedBrowserTabSnapshot {
  id: string;
  url: string;
  title: string;
}

export interface ManagedBrowserAccountStateSummary {
  status: 'empty' | 'available' | 'account_state_expired';
  cookieCount: number;
  expiredCookieCount: number;
  originCount: number;
  localStorageEntryCount: number;
  sessionStorageEntryCount: number;
  cookieDomains: string[];
  origins: string[];
  updatedAtMs: number;
  storageStatePath?: string | null;
}

export type ManagedBrowserMode = 'headless' | 'visible';
export type ManagedBrowserProvider = 'system-chrome-cdp' | 'playwright-bundled';
export type ManagedBrowserProviderPreference = ManagedBrowserProvider | 'auto';
export type ManagedBrowserProfileMode = 'persistent' | 'isolated';
export type ManagedBrowserLeaseStatus = 'active' | 'expired' | 'released';
export type ManagedBrowserProxyMode = 'direct' | 'http' | 'socks';
export type ManagedBrowserProxySource = 'default' | 'env' | 'request';

export interface ManagedBrowserLeaseState {
  leaseId: string;
  owner: string;
  acquiredAtMs: number;
  lastHeartbeatAtMs: number;
  expiresAtMs: number;
  ttlMs: number;
  status: ManagedBrowserLeaseStatus;
}

export interface ManagedBrowserProxyConfig {
  mode: ManagedBrowserProxyMode;
  server?: string | null;
  bypass: string[];
  regionHint?: string | null;
  source: ManagedBrowserProxySource;
}

export interface ManagedBrowserExternalBridgeState {
  enabled: false;
  status: 'unsupported';
  requiresExplicitAuthorization: true;
  reason: string;
}

export interface WorkbenchSnapshotRef {
  url?: string | null;
  title?: string | null;
  appName?: string | null;
  screenshotPath?: string | null;
  capturedAtMs?: number | null;
}

export type ComputerSurfaceFailureKind =
  | 'permission_denied'
  | 'target_app_not_running'
  | 'target_not_frontmost'
  | 'target_window_not_found'
  | 'ax_unavailable'
  | 'ax_tree_poor'
  | 'locator_missing'
  | 'locator_ambiguous'
  | 'coordinate_untrusted'
  | 'action_execution_failed'
  | 'evidence_unavailable';

export type ComputerSurfaceAxQualityGrade = 'good' | 'usable' | 'poor';

export interface ComputerSurfaceAxQuality {
  score: number;
  grade: ComputerSurfaceAxQualityGrade;
  elementCount: number;
  labeledElementCount: number;
  withAxPathCount: number;
  unlabeledRatio: number;
  missingAxPathRatio: number;
  duplicateLabelRoleCount: number;
  roleCounts: Record<string, number>;
  reasons: string[];
}

export interface WorkbenchActionTrace {
  id: string;
  targetKind: 'browser' | 'computer';
  toolName: string;
  action: string;
  mode: string;
  provider?: ManagedBrowserProvider | null;
  executable?: string | null;
  cdpPort?: number | null;
  profileDir?: string | null;
  missingExecutable?: boolean | null;
  recommendedAction?: string | null;
  startedAtMs: number;
  completedAtMs?: number | null;
  before?: WorkbenchSnapshotRef | null;
  after?: WorkbenchSnapshotRef | null;
  params?: Record<string, unknown>;
  success?: boolean | null;
  error?: string | null;
  screenshotPath?: string | null;
  consoleErrors?: string[];
  networkFailures?: string[];
  failureKind?: ComputerSurfaceFailureKind | null;
  blockingReasons?: string[];
  evidenceSummary?: string[];
  axQuality?: ComputerSurfaceAxQuality | null;
}

export interface ManagedBrowserSessionState {
  sessionId?: string | null;
  profileId?: string | null;
  profileMode?: ManagedBrowserProfileMode;
  workspaceScope?: string | null;
  artifactDir?: string | null;
  lease?: ManagedBrowserLeaseState | null;
  proxy?: ManagedBrowserProxyConfig | null;
  externalBridge?: ManagedBrowserExternalBridgeState | null;
  accountState?: ManagedBrowserAccountStateSummary | null;
  running: boolean;
  tabCount: number;
  activeTab?: ManagedBrowserTabSnapshot | null;
  mode?: ManagedBrowserMode;
  provider?: ManagedBrowserProvider | null;
  requestedProvider?: ManagedBrowserProviderPreference | null;
  executable?: string | null;
  cdpPort?: number | null;
  profileDir?: string | null;
  missingExecutable?: boolean | null;
  recommendedAction?: string | null;
  providerFallbackReason?: string | null;
  viewport?: { width: number; height: number } | null;
  allowedHosts?: string[];
  blockedHosts?: string[];
  lastTrace?: WorkbenchActionTrace | null;
}

export type ComputerSurfaceMode =
  | 'background_ax'
  | 'background_cgevent'
  | 'foreground_fallback'
  | 'background_surface_unavailable';

export interface ComputerSurfaceSnapshot {
  capturedAtMs: number;
  appName?: string | null;
  windowTitle?: string | null;
  screenshotPath?: string | null;
}

export interface ComputerSurfaceState {
  id: string;
  mode: ComputerSurfaceMode;
  platform: string;
  ready: boolean;
  background: boolean;
  requiresForeground?: boolean;
  approvalScope?: 'session_app' | 'per_action' | 'blocked';
  safetyNote?: string | null;
  targetApp?: string | null;
  blockedReason?: string | null;
  approvedApps: string[];
  deniedApps: string[];
  lastAction?: WorkbenchActionTrace | null;
  lastSnapshot?: ComputerSurfaceSnapshot | null;
  failureKind?: ComputerSurfaceFailureKind | null;
  blockingReasons?: string[];
  recommendedAction?: string | null;
  evidenceSummary?: string[];
  axQuality?: ComputerSurfaceAxQuality | null;
}

export interface DesktopTimelineQuery {
  from?: number;
  to?: number;
  appName?: string;
  hasUrl?: boolean;
  limit?: number;
}

export interface DesktopSearchQuery extends DesktopTimelineQuery {
  query: string;
}

export interface DesktopSearchResult {
  event: DesktopActivityEvent;
  score: number;
}

export interface DesktopActivityStats {
  totalEvents: number;
  uniqueApps: number;
  withUrls: number;
  firstEventAtMs?: number | null;
  lastEventAtMs?: number | null;
  byApp: Array<{
    appName: string;
    count: number;
  }>;
}

export interface AudioSegment {
  id: string;
  start_at_ms: number;
  end_at_ms: number;
  duration_ms: number;
  wav_path?: string | null;
  transcript: string;
  speaker_id?: number | null;
  asr_engine?: string | null;
}

export interface DesktopActivitySliceSummary {
  sliceKey: string;
  fromMs: number;
  toMs: number;
  eventCount: number;
  lastCapturedAtMs: number;
  summary: string;
  salientSubjects: string[];
  topApps: Array<{
    appName: string;
    count: number;
  }>;
  domains: string[];
}

export interface DesktopActivityTodoCandidate {
  id: string;
  sliceKey: string;
  content: string;
  activeForm: string;
  status: 'pending';
  confidence: number;
  evidence: string[];
  createdAtMs: number;
}

export interface DesktopActivitySemanticMatch {
  summary: DesktopActivitySliceSummary;
  score: number;
  snippet: string;
}
