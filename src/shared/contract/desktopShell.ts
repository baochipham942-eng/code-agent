import type { RendererBundleActiveStatus, RendererBundleStatus, RuntimeAssetsStatus } from './update';
import type { PersistenceHealth } from './persistence';
import type { NativePermissionSnapshot } from './nativeDesktop';

export type DesktopShellBootStage =
  | 'channel-env-applied'
  | 'resource-preflight'
  | 'server-script-resolved'
  | 'node-binary-resolved'
  | 'web-server-spawned'
  | 'health-ready'
  | 'window-navigated'
  | 'failed';

export type DesktopShellIssueSeverity = 'info' | 'warning' | 'error';

export interface DesktopShellIssue {
  severity: DesktopShellIssueSeverity;
  code: string;
  message: string;
  action?: string;
}

export interface DesktopShellPreviousFailure {
  stage: DesktopShellBootStage;
  recordedStage?: DesktopShellBootStage;
  generatedAt?: string;
  code?: string;
  message?: string;
  action?: string;
  diagnosticFile?: string;
  webPort?: number;
  webServerPid?: number;
}

export type DesktopShellRepairActionKind =
  | 'clear-webserver-port'
  | 'rebuild-renderer-cache'
  | 'disable-hot-renderer'
  | 'rebuild-desktop-bundle'
  | 'inspect-boot-diagnostics';

export interface DesktopShellRepairAction {
  kind: DesktopShellRepairActionKind;
  label: string;
  reason: string;
  command?: string;
  env?: Record<string, string>;
}

export type DesktopShellChannel = 'dev' | 'prod';
export type DesktopShellChannelIsolationStatus = 'ok' | 'warning';

export interface DesktopShellChannelIsolationCheck {
  id: 'data-dir' | 'web-port' | 'bundle-id' | 'permission-bundle-id';
  label: string;
  status: DesktopShellChannelIsolationStatus;
  detail: string;
}

export interface DesktopShellChannelIsolation {
  channel: DesktopShellChannel;
  status: DesktopShellChannelIsolationStatus;
  bundleId?: string;
  dataDir: string;
  webPort: number;
  expectedWebPort: number;
  checks: DesktopShellChannelIsolationCheck[];
}

export type DesktopShellResourceKind =
  | 'web-server'
  | 'renderer'
  | 'runtime'
  | 'native-module'
  | 'resource';

export type DesktopShellResourceStatus = 'present' | 'missing' | 'not-executable' | 'unknown';

export interface DesktopShellResourceCheck {
  id: string;
  label: string;
  kind: DesktopShellResourceKind;
  path?: string;
  required: boolean;
  status: DesktopShellResourceStatus;
  message?: string;
}

export type RendererServeSource = 'active' | 'builtin' | 'static';

export type RendererServeDecisionReason =
  | 'active-healthy'
  | 'static-override'
  | 'hot-update-disabled'
  | 'no-active-meta'
  | 'invalid-active-meta'
  | 'active-index-missing'
  | 'active-older-than-shell';

export interface RendererServeDecision {
  source: RendererServeSource;
  reason: RendererServeDecisionReason;
  serveDir: string;
  builtinDir: string;
  activeDir?: string;
  activeBundle: RendererBundleActiveStatus | null;
  currentShellVersion?: string;
  disabledReason?: string;
}

export type DesktopShellWebHealthStatus =
  | 'ok'
  | 'unreachable'
  | 'boot-token-mismatch'
  | 'unknown';

export interface DesktopShellBootDiagnostics {
  schemaVersion: 1;
  generatedAt: string;
  appVersion?: string;
  bundleId?: string;
  pid: number;
  webPort: number;
  stage: DesktopShellBootStage;
  failedStage?: DesktopShellBootStage;
  healthUrl?: string;
  bootId?: string;
  webServerPid?: number;
  serverRoot?: string;
  scriptPath?: string;
  nodeBinary?: string;
  healthMatchedBootToken?: boolean;
  diagnosticFile?: string;
  previousFailure?: DesktopShellPreviousFailure;
  resources?: DesktopShellResourceCheck[];
  issues?: DesktopShellIssue[];
}

export interface DesktopShellDiagnostics {
  schemaVersion: 1;
  generatedAt: string;
  app: {
    version: string;
    mode: 'tauri' | 'web';
    bundleId?: string;
    dataDir: string;
    webPort: number;
    pid: number;
    channel?: DesktopShellChannel;
  };
  boot: {
    stage: DesktopShellBootStage | 'unknown';
    failedStage?: DesktopShellBootStage;
    bootId?: string;
    pid?: number;
    webServerPid?: number;
    serverRoot?: string;
    scriptPath?: string;
    nodeBinary?: string;
    diagnosticFile?: string;
    generatedAt?: string;
    healthMatchedBootToken?: boolean;
    previousFailure?: DesktopShellPreviousFailure;
  };
  webServer: {
    url: string;
    health: DesktopShellWebHealthStatus;
    pid?: number;
    serverRoot?: string;
    persistence?: PersistenceHealth;
    errorMessage?: string;
  };
  renderer: RendererServeDecision | null;
  resources: DesktopShellResourceCheck[];
  runtimeAssets: RuntimeAssetsStatus | null;
  nativePermissions?: NativePermissionSnapshot | null;
  rendererBundle: RendererBundleStatus | null;
  channelIsolation?: DesktopShellChannelIsolation;
  repairActions?: DesktopShellRepairAction[];
  issues: DesktopShellIssue[];
}
