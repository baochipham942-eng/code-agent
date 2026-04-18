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

export interface ManagedBrowserSessionState {
  running: boolean;
  tabCount: number;
  activeTab?: ManagedBrowserTabSnapshot | null;
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
