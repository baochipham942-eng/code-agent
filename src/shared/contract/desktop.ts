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

/** ADR-041: browser_action engine selection (Managed vs Relay). */
export type BrowserActionEngine = 'auto' | 'managed' | 'relay';

/**
 * Execution provider recorded in proof / workbench traces.
 * Import source is separate from the runtime provider that holds the session.
 */
export type BrowserExecutionProvider =
  | ManagedBrowserProvider
  | 'browser-relay';

/** Alma-aligned Chromium-family browser sources for profile cookie import (macOS first). */
export type BrowserProfileSourceId =
  | 'chrome'
  | 'chrome-beta'
  | 'chrome-canary'
  | 'chromium'
  | 'edge'
  | 'brave'
  | 'arc'
  | 'vivaldi';

export type BrowserProfileUnavailableReason =
  | 'unsupported_platform'
  | 'app_not_found'
  | 'profile_dir_missing'
  | 'cookie_db_missing'
  | 'cookie_db_locked'
  | 'keychain_unavailable'
  | 'schema_unsupported'
  | 'unknown';

export interface BrowserProfileDescriptor {
  source: BrowserProfileSourceId;
  appName: string;
  profileId: string;
  profileName: string;
  /** Absolute profile directory. UI should show path tail only. */
  profileDir: string;
  cookieDbPath?: string | null;
  lastActiveAtMs?: number | null;
  available: boolean;
  unavailableReason?: BrowserProfileUnavailableReason | null;
  unavailableMessage?: string | null;
}

export interface BrowserCookieImportRequest {
  source: BrowserProfileSourceId;
  profileId: string;
  /** When set, only cookies whose domain matches (exact or subdomain) are imported. */
  domainAllowlist?: string[];
  includeExpired?: boolean;
  /** Legacy compatibility signal. Callers must separately hold a one-time Host approval. */
  userConfirmed: true;
}

export type BrowserCookieImportFailureCode =
  | 'unsupported_platform'
  | 'profile_not_found'
  | 'cookie_db_missing'
  | 'cookie_db_copy_failed'
  | 'keychain_denied'
  | 'keychain_unavailable'
  | 'decrypt_failed'
  | 'schema_unsupported'
  | 'not_confirmed'
  | 'managed_browser_unavailable'
  | 'unknown';

export interface BrowserCookieImportResult {
  ok: boolean;
  source: BrowserProfileSourceId;
  profileId: string;
  profileName?: string | null;
  importedCookieCount: number;
  skippedCookieCount: number;
  expiredSkippedCount: number;
  domainCount: number;
  /** Truncated domain list for UI/proof (never cookie values). */
  domains: string[];
  selectedDomainCount?: number | null;
  accountState?: ManagedBrowserAccountStateSummary | null;
  failureCode?: BrowserCookieImportFailureCode | null;
  failureMessage?: string | null;
  warnings: string[];
  durationMs: number;
  importSource: {
    kind: 'browser-profile-cookies';
    source: BrowserProfileSourceId;
    profileId: string;
  };
}

export interface BrowserEngineRecovery {
  code: string;
  requestedEngine: BrowserActionEngine;
  selectedEngine: BrowserActionEngine | null;
  recoverable: boolean;
  recommendedAction: string;
  availableEngines: BrowserActionEngine[];
  reason?: string | null;
}

export interface BrowserEngineRouteDecision {
  selectedEngine: 'managed' | 'relay';
  requestedEngine: BrowserActionEngine;
  reason: string;
  recovery?: BrowserEngineRecovery | null;
}

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

export type ManagedBrowserExternalBridgeStatus =
  | 'unsupported'
  | 'stopped'
  | 'listening'
  | 'connected'
  | 'error';

export interface ManagedBrowserExternalBridgeState {
  enabled: boolean;
  status: ManagedBrowserExternalBridgeStatus;
  requiresExplicitAuthorization: true;
  reason?: string | null;
  port?: number | null;
  authToken?: string | null;
  tokenHint?: string | null;
  extensionPath?: string | null;
  connectedTabCount?: number;
  attachedTabCount?: number;
  lastConnectedAtMs?: number | null;
  lastError?: string | null;
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
  agentPointerEvent?: AgentPointerEvent | null;
}

export type AgentPointerSurface = 'browser' | 'computer';
export type AgentPointerTone = 'idle' | 'browser' | 'computer' | 'blocked';
export type AgentPointerPhase =
  | 'preview'
  | 'click'
  | 'drag'
  | 'type'
  | 'scroll'
  | 'move'
  | 'read'
  | 'blocked'
  | 'failed'
  | 'success';
export type AgentPointerCoordSpace =
  | 'browserViewport'
  | 'screen'
  | 'windowLocal'
  | 'surfacePreview';
export type AgentPointerPointSource =
  | 'targetRefBBox'
  | 'pointerTargetBBox'
  | 'axFrame'
  | 'windowLocalPoint'
  | 'windowLocalCoordinate'
  | 'screenCoordinate'
  | 'fallback';
export type AgentPointerPointFreshness = 'fresh' | 'stale' | 'fallback';
export type AgentPointerNativeCursorStatus = 'native' | 'fallback' | 'unavailable';
export type AgentPointerNativeCursorProvider = 'cua-driver' | 'renderer' | 'pip' | 'none';

export interface AgentPointerNativeCursorCapability {
  enabled: boolean;
  status: AgentPointerNativeCursorStatus;
  provider: AgentPointerNativeCursorProvider;
  supportsSystemOverlay: boolean;
  reason?: string | null;
  fallbackSurface?: 'renderer' | 'pip' | null;
  checkedAtMs?: number | null;
}

export interface AgentPointerPoint {
  x: number;
  y: number;
  unit: 'px' | 'percent';
}

export interface AgentPointerEvent {
  id: string;
  surface: AgentPointerSurface;
  tone: AgentPointerTone;
  phase: AgentPointerPhase;
  coordSpace: AgentPointerCoordSpace;
  point?: AgentPointerPoint | null;
  pointSource?: AgentPointerPointSource | null;
  pointFreshness?: AgentPointerPointFreshness | null;
  targetLabel?: string | null;
  targetSource?: 'targetRef' | 'selector' | 'axPath' | 'windowRef' | 'coordinate' | 'fallback' | null;
  traceId?: string | null;
  nativeCursor?: AgentPointerNativeCursorCapability | null;
  success?: boolean | null;
  occurredAtMs?: number | null;
  startedAtMs?: number | null;
  completedAtMs?: number | null;
  expiresAtMs?: number | null;
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
  failureKind?: ComputerSurfaceFailureKind | null;
  blockingReasons?: string[];
  recommendedAction?: string | null;
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

// ---------------------------------------------------------------------------
// Stateful CUA computer-use contract (V1)
// ---------------------------------------------------------------------------

export interface ComputerUseRootRefV1 {
  provider: 'cua-driver';
  pid: number;
  windowId: number;
  appName?: string | null;
  title?: string | null;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  isOnScreen?: boolean | null;
  onCurrentSpace?: boolean | null;
}

export interface ComputerUseElementViewV1 {
  ref: string;
  role: string;
  label?: string | null;
  value?: string | null;
  frame?: { x: number; y: number; width: number; height: number } | null;
  parentRef?: string | null;
  depth?: number | null;
}

export interface ComputerUseStateViewV1 {
  version: 1;
  stateId: string;
  root: ComputerUseRootRefV1;
  hostRevision: number;
  observedAtMs: number;
  expiresAtMs: number;
  screenshotId?: string | null;
  screenshotWidth?: number | null;
  screenshotHeight?: number | null;
  degraded?: boolean;
  degradedReason?: string | null;
  elements: ComputerUseElementViewV1[];
}

type ComputerUseMutationKindV1 =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'set_value'
  | 'type_text'
  | 'press_key'
  | 'hotkey'
  | 'scroll'
  | 'drag';

export interface ComputerUseMutationV1 {
  kind: ComputerUseMutationKindV1;
  elementRef?: string;
  point?: { x: number; y: number; screenshotId: string };
  toPoint?: { x: number; y: number; screenshotId: string };
  value?: string;
  key?: string;
  keys?: string[];
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  deliveryMode?: 'background' | 'foreground';
}

type ComputerUseExpectationKindV1 =
  | 'element_exists'
  | 'element_absent'
  | 'element_value_equals'
  | 'text_present'
  | 'window_present';

export interface ComputerUseExpectationV1 {
  kind: ComputerUseExpectationKindV1;
  elementRef?: string;
  text?: string;
  value?: string;
}

type ComputerUseDeliveryV1 =
  | 'not_attempted'
  | 'confirmed'
  | 'rejected'
  | 'unknown';

type ComputerUseVerificationV1 =
  | 'preexisting'
  | 'satisfied'
  | 'unsatisfied'
  | 'inconclusive'
  | 'not_requested';

type ComputerUseOverallV1 =
  | 'succeeded'
  | 'failed'
  | 'ambiguous'
  | 'delivered_unverified';

export type ComputerUseStateErrorKindV1 =
  | 'invalid_request'
  | 'stale_state'
  | 'state_conflict'
  | 'provider_restarted'
  | 'target_missing'
  | 'delivery_unknown'
  | 'verification_failed'
  | 'provider_error';

export interface ComputerUseActionResultV1 {
  version: 1;
  predecessorStateId: string;
  delivery: ComputerUseDeliveryV1;
  verification: ComputerUseVerificationV1;
  overall: ComputerUseOverallV1;
  successorState?: ComputerUseStateViewV1;
  evidenceRef: string;
  error?: {
    kind: ComputerUseStateErrorKindV1;
    message: string;
  };
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
