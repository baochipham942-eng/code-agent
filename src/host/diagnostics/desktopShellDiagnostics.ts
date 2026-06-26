import fs from 'fs';
import path from 'path';
import type {
  DesktopShellBootDiagnostics,
  DesktopShellChannel,
  DesktopShellChannelIsolation,
  DesktopShellChannelIsolationCheck,
  DesktopShellDiagnostics,
  DesktopShellIssue,
  DesktopShellPreviousFailure,
  DesktopShellRepairAction,
  DesktopShellResourceCheck,
  DesktopShellResourceKind,
  DesktopShellResourceStatus,
  DesktopShellWebHealthStatus,
  RendererServeDecision,
  WebHealthResponse,
} from '../../shared/contract';
import { app } from '../platform';
import { getRuntimeAssetsStatus } from '../runtime/runtimeAssetStatus';
import { readRendererBundleStatus, resolveRendererServeDecision } from '../services/renderer/rendererBundleCache';

const BOOT_DIAGNOSTICS_FILE = 'desktop-shell-boot-latest.json';
const BOOT_DIAGNOSTICS_PATH_ENV = 'AGENT_NEO_TAURI_BOOT_DIAGNOSTICS_FILE';
const DEFAULT_WEB_PORT = 8180;
const DEV_WEB_PORT = 8181;
const PROD_BUNDLE_ID = 'com.linchen.code-agent';
const DEV_BUNDLE_ID = 'com.linchen.code-agent.dev';
const DEV_DATA_DIR_NAME = '.code-agent-dev';

const BUNDLED_NODE_PATHS = [
  ['dist', 'bundled-node', 'bin', 'node'],
  ['dist', 'bundled-node', 'node'],
  ['bundled-node', 'bin', 'node'],
  ['bundled-node', 'node'],
  ['dist', 'bundled-node', 'node.exe'],
  ['bundled-node', 'node.exe'],
] as const;

type ResourceDefinition = {
  id: string;
  label: string;
  kind: DesktopShellResourceKind;
  required: boolean;
  relativePath?: readonly string[];
  candidates?: readonly (readonly string[])[];
  executable?: boolean;
};

const RESOURCE_DEFINITIONS: ResourceDefinition[] = [
  {
    id: 'web-server-script',
    label: 'webServer bundle',
    kind: 'web-server',
    required: true,
    relativePath: ['dist', 'web', 'webServer.cjs'],
  },
  {
    id: 'renderer-index',
    label: 'builtin renderer index',
    kind: 'renderer',
    required: true,
    relativePath: ['dist', 'renderer', 'index.html'],
  },
  {
    id: 'bundled-node',
    label: 'bundled Node',
    kind: 'runtime',
    required: true,
    candidates: BUNDLED_NODE_PATHS,
    executable: true,
  },
  {
    id: 'control-plane-public-keys',
    label: 'control-plane public keys',
    kind: 'resource',
    required: false,
    relativePath: ['dist', 'web', 'control-plane-public-keys.json'],
  },
  {
    id: 'better-sqlite3-native',
    label: 'better-sqlite3 native module',
    kind: 'native-module',
    required: true,
    relativePath: ['dist', 'native', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function webPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WEB_PORT ?? env.CODE_AGENT_WEB_PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEB_PORT;
}

function resolveResourceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicitRoot = env.AGENT_NEO_BUNDLED_RUNTIME_ROOT?.trim();
  if (explicitRoot) return path.resolve(explicitRoot);

  const resourceDir = env.AGENT_NEO_RESOURCE_DIR?.trim();
  if (resourceDir) {
    const upRoot = path.resolve(resourceDir, '_up_');
    return fs.existsSync(upRoot) ? upRoot : path.resolve(resourceDir);
  }

  return process.cwd();
}

function inferDesktopShellChannel(input: {
  bundleId?: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}): DesktopShellChannel {
  if (input.bundleId === DEV_BUNDLE_ID) return 'dev';
  if (path.basename(input.dataDir) === DEV_DATA_DIR_NAME) return 'dev';
  if (input.env?.NODE_ENV === 'development') return 'dev';
  return 'prod';
}

function getChannelIsolation(input: {
  bundleId?: string;
  dataDir: string;
  webPort: number;
  env?: NodeJS.ProcessEnv;
}): DesktopShellChannelIsolation {
  const env = input.env ?? process.env;
  const channel = inferDesktopShellChannel({ ...input, env });
  const packagedDev = input.bundleId === DEV_BUNDLE_ID;
  const debugDev = channel === 'dev' && !packagedDev && env.NODE_ENV === 'development';
  const expectedWebPort = packagedDev ? DEV_WEB_PORT : DEFAULT_WEB_PORT;
  const dataDirBase = path.basename(input.dataDir);
  const checks: DesktopShellChannelIsolationCheck[] = [
    {
      id: 'data-dir',
      label: 'data dir',
      status: channel === 'dev'
        ? dataDirBase === DEV_DATA_DIR_NAME ? 'ok' : 'warning'
        : dataDirBase === DEV_DATA_DIR_NAME ? 'warning' : 'ok',
      detail: input.dataDir,
    },
    {
      id: 'web-port',
      label: 'web port',
      status: input.webPort === expectedWebPort ? 'ok' : 'warning',
      detail: `${input.webPort} (expected ${expectedWebPort})`,
    },
    {
      id: 'bundle-id',
      label: 'bundle id',
      status: channel === 'prod'
        ? input.bundleId === PROD_BUNDLE_ID || !input.bundleId ? 'ok' : 'warning'
        : packagedDev || debugDev ? 'ok' : 'warning',
      detail: input.bundleId ?? 'unknown',
    },
    {
      id: 'permission-bundle-id',
      label: 'permission bundle id',
      status: env.CODE_AGENT_BUNDLE_ID && input.bundleId && env.CODE_AGENT_BUNDLE_ID !== input.bundleId
        ? 'warning'
        : 'ok',
      detail: env.CODE_AGENT_BUNDLE_ID ?? input.bundleId ?? 'unknown',
    },
  ];

  return {
    channel,
    status: checks.some((check) => check.status === 'warning') ? 'warning' : 'ok',
    ...(input.bundleId ? { bundleId: input.bundleId } : {}),
    dataDir: input.dataDir,
    webPort: input.webPort,
    expectedWebPort,
    checks,
  };
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function fileStatus(filePath: string, executable: boolean | undefined): DesktopShellResourceStatus {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return 'missing';
    if (executable && !isExecutableFile(filePath)) return 'not-executable';
    return 'present';
  } catch {
    return 'missing';
  }
}

function checkResource(root: string, definition: ResourceDefinition): DesktopShellResourceCheck {
  const candidates = definition.candidates ?? (definition.relativePath ? [definition.relativePath] : []);
  const candidatePaths = candidates.map((segments) => path.join(root, ...segments));
  const presentCandidate = candidatePaths.find((candidate) => fs.existsSync(candidate));
  const targetPath = presentCandidate ?? candidatePaths[0];
  const status = targetPath ? fileStatus(targetPath, definition.executable) : 'unknown';
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    required: definition.required,
    ...(targetPath ? { path: targetPath } : {}),
    status,
    ...(status === 'missing' ? { message: 'resource missing from packaged bundle' } : {}),
    ...(status === 'not-executable' ? { message: 'resource exists but is not executable' } : {}),
  };
}

export function getDesktopShellResourceChecks(options: {
  resourceRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): DesktopShellResourceCheck[] {
  const root = options.resourceRoot ?? resolveResourceRoot(options.env);
  return RESOURCE_DEFINITIONS.map((definition) => checkResource(root, definition));
}

function bootDiagnosticsPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicitPath = env[BOOT_DIAGNOSTICS_PATH_ENV]?.trim();
  return explicitPath ? path.resolve(explicitPath) : path.join(dataDir, 'logs', BOOT_DIAGNOSTICS_FILE);
}

function readBootDiagnostics(dataDir: string, env: NodeJS.ProcessEnv = process.env): DesktopShellBootDiagnostics | null {
  const bootPath = bootDiagnosticsPath(dataDir, env);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(bootPath, 'utf8'));
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) return null;
    return parsed as unknown as DesktopShellBootDiagnostics;
  } catch {
    return null;
  }
}

async function fetchWebHealth(url: string): Promise<{
  status: DesktopShellWebHealthStatus;
  health: WebHealthResponse | null;
  errorMessage?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!response.ok) {
      return { status: 'unreachable', health: null, errorMessage: `HTTP ${response.status}` };
    }
    return { status: 'ok', health: await response.json() as WebHealthResponse };
  } catch (error) {
    return {
      status: 'unreachable',
      health: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function resourceIssues(resources: DesktopShellResourceCheck[]): DesktopShellIssue[] {
  return resources
    .filter((resource) => resource.status !== 'present')
    .map((resource) => ({
      severity: resource.required ? 'error' : 'warning',
      code: resource.required ? 'desktop-shell-required-resource-missing' : 'desktop-shell-optional-resource-missing',
      message: `${resource.label}: ${resource.message ?? resource.status}`,
      action: resource.required ? 'Rebuild the desktop bundle and verify packaged resources.' : undefined,
    }));
}

function sanitizeBootIssues(boot: DesktopShellBootDiagnostics | null): DesktopShellIssue[] {
  return (boot?.issues ?? []).map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    action: issue.action,
  }));
}

function previousFailureIssue(previousFailure: DesktopShellPreviousFailure | null | undefined): DesktopShellIssue | null {
  if (!previousFailure) return null;
  return {
    severity: 'warning',
    code: 'desktop-shell-previous-launch-failed',
    message: previousFailure.message
      ?? `Previous desktop shell launch did not finish after ${previousFailure.stage}.`,
    action: previousFailure.action ?? 'Use the suggested repair actions before the next packaged smoke run.',
  };
}

function pushRepairAction(
  actions: DesktopShellRepairAction[],
  action: DesktopShellRepairAction,
): void {
  if (actions.some((existing) => existing.kind === action.kind)) return;
  actions.push(action);
}

function deriveRepairActions(input: {
  boot: DesktopShellBootDiagnostics | null;
  webStatus: DesktopShellWebHealthStatus;
  webError?: string;
  renderer: RendererServeDecision | null;
  resources: DesktopShellResourceCheck[];
}): DesktopShellRepairAction[] {
  const actions: DesktopShellRepairAction[] = [];
  const previousFailure = input.boot?.previousFailure;
  const issueCodes = new Set([
    ...(input.boot?.issues ?? []).map((issue) => issue.code),
    previousFailure?.code,
  ].filter(Boolean) as string[]);
  const stage = previousFailure?.stage ?? input.boot?.failedStage ?? input.boot?.stage;

  if (previousFailure || input.boot?.stage === 'failed' || input.webStatus !== 'ok') {
    pushRepairAction(actions, {
      kind: 'inspect-boot-diagnostics',
      label: '查看启动诊断',
      reason: previousFailure
        ? `上次启动停在 ${previousFailure.stage}`
        : input.webError ?? '桌面壳启动链路需要人工确认',
    });
  }

  if (
    input.webStatus === 'unreachable' ||
    input.webStatus === 'boot-token-mismatch' ||
    stage === 'web-server-spawned' ||
    issueCodes.has('desktop-shell-healthcheck-failed')
  ) {
    pushRepairAction(actions, {
      kind: 'clear-webserver-port',
      label: '清理 webServer 端口',
      reason: `localhost:${input.boot?.webPort ?? 'unknown'} healthcheck 未确认当前壳进程`,
      command: 'lsof -ti tcp:<port> | xargs kill',
    });
  }

  if (
    input.renderer?.source === 'active' ||
    input.renderer?.reason === 'active-index-missing' ||
    input.renderer?.reason === 'active-older-than-shell' ||
    issueCodes.has('desktop-shell-renderer-navigation-failed')
  ) {
    pushRepairAction(actions, {
      kind: 'disable-hot-renderer',
      label: '禁用 hot renderer',
      reason: 'renderer 热更可能影响当前壳加载，先回到包内前端验证',
      env: { CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1' },
    });
    pushRepairAction(actions, {
      kind: 'rebuild-renderer-cache',
      label: '重建 renderer 缓存',
      reason: 'active renderer 目录或版本可能与当前壳不匹配',
    });
  }

  if (input.resources.some((resource) => resource.required && resource.status !== 'present')) {
    pushRepairAction(actions, {
      kind: 'rebuild-desktop-bundle',
      label: '重建桌面包资源',
      reason: 'release 关键资源缺失或不可执行',
      command: 'npm run build:web && npm run verify:webserver-boot',
    });
  }

  return actions;
}

function resolveFallbackRendererDecision(dataDir: string): RendererServeDecision | null {
  try {
    const resourceRoot = resolveResourceRoot();
    return resolveRendererServeDecision(
      dataDir,
      path.join(resourceRoot, 'dist', 'renderer'),
      process.env,
      { currentShellVersion: app.getVersion() },
    );
  } catch {
    return null;
  }
}

export async function getDesktopShellDiagnostics(): Promise<DesktopShellDiagnostics> {
  const dataDir = app.getPath('userData');
  const shellVersion = app.getVersion();
  const port = webPort();
  const url = `http://localhost:${port}`;
  const bundleId = process.env.CODE_AGENT_BUNDLE_ID;
  const channelIsolation = getChannelIsolation({ bundleId, dataDir, webPort: port });
  const boot = readBootDiagnostics(dataDir);
  const resources = boot?.resources?.length ? boot.resources : getDesktopShellResourceChecks();
  const web = await fetchWebHealth(url);
  const healthStatus: DesktopShellWebHealthStatus =
    boot?.healthMatchedBootToken === false ? 'boot-token-mismatch' : web.status;
  const renderer = web.health?.rendererServe ?? resolveFallbackRendererDecision(dataDir);

  const runtimeAssets = await getRuntimeAssetsStatus({ shellVersion }).catch(() => null);
  const rendererBundle = (() => {
    try {
      return readRendererBundleStatus(dataDir);
    } catch {
      return null;
    }
  })();

  const issues: DesktopShellIssue[] = [
    ...sanitizeBootIssues(boot),
    ...resourceIssues(resources),
  ];
  const previousIssue = previousFailureIssue(boot?.previousFailure);
  if (previousIssue) issues.push(previousIssue);
  if (web.status !== 'ok' && web.errorMessage) {
    issues.push({
      severity: 'error',
      code: 'desktop-shell-web-health-unreachable',
      message: web.errorMessage,
      action: 'Check whether the packaged webServer process is running.',
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    app: {
      version: shellVersion,
      mode: process.env.CODE_AGENT_TAURI_BOOT_TOKEN ? 'tauri' : 'web',
      bundleId,
      dataDir,
      webPort: port,
      pid: process.pid,
      channel: channelIsolation.channel,
    },
    boot: {
      stage: boot?.stage ?? 'unknown',
      bootId: boot?.bootId,
      pid: boot?.pid,
      webServerPid: boot?.webServerPid,
      serverRoot: boot?.serverRoot,
      scriptPath: boot?.scriptPath,
      nodeBinary: boot?.nodeBinary,
      diagnosticFile: boot?.diagnosticFile ?? bootDiagnosticsPath(dataDir),
      generatedAt: boot?.generatedAt,
      healthMatchedBootToken: boot?.healthMatchedBootToken,
      failedStage: boot?.failedStage,
      previousFailure: boot?.previousFailure,
    },
    webServer: {
      url,
      health: healthStatus,
      pid: web.health?.pid,
      serverRoot: web.health?.serverRoot,
      persistence: web.health?.persistence,
      errorMessage: web.errorMessage,
    },
    renderer,
    resources,
    runtimeAssets,
    rendererBundle,
    channelIsolation,
    repairActions: deriveRepairActions({
      boot,
      webStatus: healthStatus,
      webError: web.errorMessage,
      renderer,
      resources,
    }),
    issues,
  };
}
