import type { AudioSegment, DesktopActivityEvent } from './desktop';

export type ActivityContextSourceKind =
  | 'openchronicle'
  | 'tauri-native-desktop'
  | 'audio'
  | 'screenshot-analysis';

export type ActivityContextSourceStatus = 'available' | 'unavailable';

export type ActivityContextPrivacy = 'local-only' | 'redacted' | 'unknown';

export interface ActivityEvidenceRef {
  source: ActivityContextSourceKind;
  kind: 'openchronicle-context' | 'desktop-event' | 'audio-segment' | 'screenshot-analysis';
  id: string;
  label?: string | null;
  path?: string | null;
  capturedAtMs?: number | null;
  startAtMs?: number | null;
  endAtMs?: number | null;
}

export interface ActivityContextItem {
  id: string;
  title?: string | null;
  text?: string | null;
  appName?: string | null;
  windowTitle?: string | null;
  browserUrl?: string | null;
  screenshotPath?: string | null;
  capturedAtMs?: number | null;
  startAtMs?: number | null;
  endAtMs?: number | null;
  confidence?: number;
  evidenceRefs?: ActivityEvidenceRef[];
  raw?: DesktopActivityEvent | AudioSegment | null;
}

export interface ActivityContextSource {
  source: ActivityContextSourceKind;
  status: ActivityContextSourceStatus;
  confidence: number;
  privacy: ActivityContextPrivacy;
  generatedAtMs: number;
  maxChars: number;
  text?: string | null;
  items?: ActivityContextItem[];
  evidenceRefs: ActivityEvidenceRef[];
  unavailableReason?: string | null;
}

export interface ActivityContextTokenBudgetHint {
  maxChars: number;
  targetTokens: number;
}

export interface ActivityContext {
  generatedAtMs: number;
  maxChars: number;
  tokenBudgetHint: ActivityContextTokenBudgetHint;
  sources: ActivityContextSource[];
  evidenceRefs: ActivityEvidenceRef[];
}
