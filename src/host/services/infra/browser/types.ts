import type { Page } from 'playwright';
import type {
  ManagedBrowserAccountStateSummary,
  ManagedBrowserExternalBridgeState,
  ManagedBrowserMode,
  ManagedBrowserProfileMode,
  ManagedBrowserProvider,
  ManagedBrowserProviderPreference,
  ManagedBrowserProxyMode,
} from '../../../../shared/contract/desktop';

export interface BrowserTab {
  id: string;
  page: Page;
  url: string;
  title: string;
}

export interface ScreenshotResult {
  success: boolean;
  path?: string;
  base64?: string;
  error?: string;
}

export interface PageContent {
  url: string;
  title: string;
  text: string;
  html?: string;
  links?: Array<{ text: string; href: string }>;
}

export interface ElementInfo {
  selector: string;
  text: string;
  tagName: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

export interface BrowserTargetRef {
  refId: string;
  source: 'dom';
  selector: string;
  role?: string | null;
  name?: string | null;
  textHint?: string | null;
  frameId?: string | null;
  tabId: string;
  snapshotId: string;
  capturedAtMs: number;
  ttlMs: number;
  confidence: number;
  rect?: { x: number; y: number; width: number; height: number } | null;
}

export interface BrowserDomSnapshot {
  snapshotId: string;
  tabId: string;
  capturedAtMs: number;
  url: string;
  title: string;
  headings: Array<{ level: number; text: string }>;
  interactiveElements: Array<{
    tag: string;
    role?: string | null;
    text: string;
    ariaLabel?: string | null;
    placeholder?: string | null;
    selectorHint: string;
    targetRef: BrowserTargetRef;
    rect: { x: number; y: number; width: number; height: number };
  }>;
}

export interface ManagedBrowserLaunchOptions {
  mode?: ManagedBrowserMode;
  provider?: ManagedBrowserProviderPreference;
  profileMode?: ManagedBrowserProfileMode;
  leaseOwner?: string;
  leaseTtlMs?: number;
  proxy?: ManagedBrowserProxyInput | null;
}

export interface ManagedBrowserProxyInput {
  mode?: ManagedBrowserProxyMode | 'auto' | 'none' | 'off' | 'direct';
  server?: string | null;
  bypass?: string[] | string | null;
  regionHint?: string | null;
}

export interface ManagedBrowserProfileResolution {
  sessionId: string;
  profileId: string;
  profileMode: ManagedBrowserProfileMode;
  profileDir: string;
  workspaceScope: string;
  artifactDir: string;
  temporary: boolean;
  isolatedRootDir: string | null;
}

export interface BrowserStorageStateArtifact {
  path: string;
  accountState: ManagedBrowserAccountStateSummary;
}

export interface BrowserArtifactSummary {
  artifactId: string;
  kind: 'download' | 'upload';
  name: string;
  artifactPath: string;
  size: number;
  mimeType: string | null;
  sha256: string;
  createdAtMs: number;
  sessionId: string | null;
}

export interface BrowserStorageStateCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  sameSite?: unknown;
}

export interface BrowserStorageStateOrigin {
  origin?: unknown;
  localStorage?: unknown;
  sessionStorage?: unknown;
}

export interface BrowserStorageStateLike {
  cookies?: unknown;
  origins?: unknown;
}

export interface BrowserProviderDiagnostics {
  provider: ManagedBrowserProvider | null;
  requestedProvider: ManagedBrowserProviderPreference | null;
  executable: string | null;
  cdpPort: number | null;
  missingExecutable: boolean;
  recommendedAction: string | null;
  providerFallbackReason: string | null;
}

export interface BrowserTargetRefRecord {
  targetRef: BrowserTargetRef;
  url: string;
}

export class BrowserTargetRefError extends Error {
  readonly code = 'STALE_TARGET_REF';
  readonly recoverable = true;
  readonly retryHint = 'Run browser_action.get_dom_snapshot and retry with a fresh targetRef.';

  constructor(
    message: string,
    readonly refId: string | null,
    readonly snapshotId: string | null,
  ) {
    super(message);
    this.name = 'BrowserTargetRefError';
  }
}

export type { ManagedBrowserExternalBridgeState };
