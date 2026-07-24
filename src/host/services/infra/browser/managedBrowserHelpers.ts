import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import type {
  ManagedBrowserExternalBridgeState,
  ManagedBrowserLeaseState,
  ManagedBrowserProfileMode,
  ManagedBrowserProxyConfig,
  ManagedBrowserProxyMode,
} from '../../../../shared/contract/desktop';
import {
  redactBrowserComputerInputArgs,
  redactBrowserComputerInputPayloadsInValue,
} from '../../../../shared/utils/browserComputerRedaction';
import type {
  BrowserArtifactSummary,
  BrowserStorageStateCookie,
  BrowserStorageStateLike,
  BrowserStorageStateOrigin,
  ManagedBrowserProfileResolution,
  ManagedBrowserProxyInput,
} from './types';
import { isPathWithinRoot } from '../../../runtime/workspaceScope';

export const MANAGED_BROWSER_PERSISTENT_PROFILE_ID = 'managed-browser-profile';
export const MANAGED_BROWSER_ARTIFACT_DIR = 'screenshots';
export const MANAGED_BROWSER_ARTIFACT_ROOT_DIR = 'managed-browser-artifacts';
export const MANAGED_BROWSER_ISOLATED_PROFILE_PREFIX = 'code-agent-managed-browser-';
export const BROWSER_TARGET_REF_TTL_MS = 60_000;
export const MANAGED_BROWSER_DEFAULT_LEASE_TTL_MS = 30 * 60_000;
export const MANAGED_BROWSER_MIN_LEASE_TTL_MS = 5_000;
export const MANAGED_BROWSER_MAX_LEASE_TTL_MS = 4 * 60 * 60_000;
export const MANAGED_BROWSER_EXTERNAL_BRIDGE_UNSUPPORTED: ManagedBrowserExternalBridgeState = {
  enabled: false,
  status: 'unsupported',
  requiresExplicitAuthorization: true,
  reason: 'External browser attach and extension bridge are intentionally disabled for the in-app managed browser baseline.',
};

export function parseHostList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function matchesHostList(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix);
    }
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}

export function isLocalHost(host: string): boolean {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.local');
}

export function buildBrowserEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

export function getDefaultUserAgent(): string {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

export function summarizeBrowserUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`;
    }
    if (url.protocol === 'about:' && url.pathname === 'blank') {
      return 'about:blank';
    }
    if (url.protocol === 'blob:') {
      return url.origin !== 'null' ? `blob:${url.origin}/[redacted]` : 'blob:[redacted]';
    }
    return `${url.protocol}[redacted]`;
  } catch {
    return '[invalid URL]';
  }
}

export function resolveManagedBrowserWorkspaceScope(workspacePath: string): string {
  const name = path.basename(path.resolve(workspacePath || process.cwd()));
  return sanitizeManagedBrowserId(name || 'workspace');
}

export function createManagedBrowserSessionId(now = Date.now()): string {
  return `browser_session_${now}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createManagedBrowserLease(args: {
  owner?: string | null;
  ttlMs?: number | null;
  nowMs?: number;
  leaseId?: string | null;
  acquiredAtMs?: number | null;
} = {}): ManagedBrowserLeaseState {
  const nowMs = args.nowMs ?? Date.now();
  const ttlMs = clampManagedBrowserLeaseTtl(args.ttlMs);
  return {
    leaseId: args.leaseId || `lease_${nowMs}_${Math.random().toString(36).slice(2, 8)}`,
    owner: sanitizeManagedBrowserId(args.owner || 'managed-browser'),
    acquiredAtMs: args.acquiredAtMs || nowMs,
    lastHeartbeatAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    ttlMs,
    status: 'active',
  };
}

export function isManagedBrowserLeaseExpired(lease: ManagedBrowserLeaseState, nowMs = Date.now()): boolean {
  return lease.status === 'active' && lease.expiresAtMs <= nowMs;
}

function clampManagedBrowserLeaseTtl(value: number | null | undefined): number {
  if (!Number.isFinite(value || NaN)) {
    return MANAGED_BROWSER_DEFAULT_LEASE_TTL_MS;
  }
  return Math.min(
    MANAGED_BROWSER_MAX_LEASE_TTL_MS,
    Math.max(MANAGED_BROWSER_MIN_LEASE_TTL_MS, Math.floor(value as number)),
  );
}

export function resolveManagedBrowserProxyConfig(args: {
  input?: ManagedBrowserProxyInput | null;
  env?: NodeJS.ProcessEnv;
} = {}): ManagedBrowserProxyConfig {
  const env = args.env || process.env;
  const input = args.input;
  const source = input ? 'request' : env.CODE_AGENT_BROWSER_PROXY_SERVER ? 'env' : 'default';
  const rawMode = input?.mode;
  const rawServer = input ? input.server : env.CODE_AGENT_BROWSER_PROXY_SERVER;
  const bypass = normalizeProxyBypass(input ? input.bypass : env.CODE_AGENT_BROWSER_PROXY_BYPASS);
  const rawRegionHint = (input?.regionHint || env.CODE_AGENT_BROWSER_PROXY_REGION || '').trim();
  const regionHint = rawRegionHint ? sanitizeManagedBrowserId(rawRegionHint) : null;

  if (rawMode === 'direct' || rawMode === 'none' || rawMode === 'off') {
    return {
      mode: 'direct',
      server: null,
      bypass,
      regionHint,
      source,
    };
  }

  const server = normalizeProxyServer(rawServer);
  if (!server) {
    return {
      mode: 'direct',
      server: null,
      bypass,
      regionHint,
      source,
    };
  }

  return {
    mode: normalizeProxyMode(rawMode, server),
    server,
    bypass,
    regionHint,
    source,
  };
}

export function resolveManagedBrowserProfile(args: {
  userDataDir: string;
  profileMode?: ManagedBrowserProfileMode;
  workspaceScope?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  tmpDir?: string;
  makeTempDir?: (prefix: string) => string;
}): ManagedBrowserProfileResolution {
  const profileMode = args.profileMode || 'persistent';
  const workspaceScope = sanitizeManagedBrowserId(args.workspaceScope || 'workspace');
  const sessionId = args.sessionId || createManagedBrowserSessionId();
  const agentSuffix = args.agentId ? `-${sanitizeManagedBrowserId(args.agentId)}` : '';

  if (profileMode === 'persistent') {
    const profileId = `${MANAGED_BROWSER_PERSISTENT_PROFILE_ID}${agentSuffix}`;
    return {
      sessionId,
      profileId,
      profileMode,
      profileDir: path.join(args.userDataDir, profileId),
      workspaceScope,
      artifactDir: MANAGED_BROWSER_ARTIFACT_DIR,
      temporary: false,
      isolatedRootDir: null,
    };
  }

  if (profileMode !== 'isolated') {
    throw new Error(`Unsupported managed browser profileMode: ${profileMode}`);
  }

  const profileId = sanitizeManagedBrowserId(`isolated${agentSuffix}-${sessionId}`);
  const isolatedRootDir = path.join(args.tmpDir || os.tmpdir(), MANAGED_BROWSER_ISOLATED_PROFILE_PREFIX);
  fs.mkdirSync(isolatedRootDir, { recursive: true });
  const makeTempDir = args.makeTempDir || fs.mkdtempSync;
  const profileDir = makeTempDir(path.join(isolatedRootDir, `${profileId}-`));

  return {
    sessionId,
    profileId,
    profileMode,
    profileDir,
    workspaceScope,
    artifactDir: MANAGED_BROWSER_ARTIFACT_DIR,
    temporary: true,
    isolatedRootDir,
  };
}

export function shouldCleanupManagedBrowserProfile(profile: Pick<ManagedBrowserProfileResolution, 'profileMode' | 'profileDir' | 'temporary' | 'isolatedRootDir'>): boolean {
  return profile.profileMode === 'isolated'
    && profile.temporary
    && Boolean(profile.isolatedRootDir)
    && isPathInsideRoot(profile.profileDir, profile.isolatedRootDir || '');
}

function normalizeProxyBypass(value: string[] | string | null | undefined): string[] {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(/[;,]/g);
  return Array.from(new Set(items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/\s+/g, ''))));
}

function normalizeProxyServer(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('Invalid managed browser proxy server.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Managed browser proxy credentials are not accepted in proxy URLs.');
  }
  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported managed browser proxy protocol: ${parsed.protocol}`);
  }
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/g, '');
}

function normalizeProxyMode(value: ManagedBrowserProxyInput['mode'], server: string): ManagedBrowserProxyMode {
  if (value === 'http' || value === 'socks') {
    return value;
  }
  return server.startsWith('socks') ? 'socks' : 'http';
}

export function getManagedBrowserProxyFingerprint(proxy: ManagedBrowserProxyConfig): string {
  return JSON.stringify({
    mode: proxy.mode,
    server: proxy.server || null,
    bypass: proxy.bypass,
    regionHint: proxy.regionHint || null,
  });
}

export function parseBrowserTargetRefInput(value: unknown): { refId: string | null; snapshotId: string | null } {
  if (typeof value === 'string') {
    return { refId: value.trim() || null, snapshotId: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { refId: null, snapshotId: null };
  }
  const record = value as Record<string, unknown>;
  return {
    refId: typeof record.refId === 'string' ? record.refId.trim() || null : null,
    snapshotId: typeof record.snapshotId === 'string' ? record.snapshotId.trim() || null : null,
  };
}

export function readBrowserStorageState(filePath: string): BrowserStorageStateLike {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('storageState file must contain a JSON object');
  }
  const record = parsed as BrowserStorageStateLike;
  if (record.cookies !== undefined && !Array.isArray(record.cookies)) {
    throw new Error('storageState.cookies must be an array');
  }
  if (record.origins !== undefined && !Array.isArray(record.origins)) {
    throw new Error('storageState.origins must be an array');
  }
  return record;
}

export function normalizeStorageStateCookies(value: unknown): Array<{
  name: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is BrowserStorageStateCookie => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((cookie) => ({
      name: typeof cookie.name === 'string' ? cookie.name : '',
      domain: typeof cookie.domain === 'string' ? cookie.domain : '',
      path: typeof cookie.path === 'string' ? cookie.path : '/',
      expires: typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) ? cookie.expires : -1,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      sameSite: typeof cookie.sameSite === 'string' ? cookie.sameSite : null,
    }))
    .filter((cookie) => cookie.name && cookie.domain);
}

export function normalizeStorageStateOrigins(value: unknown): Array<{
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
  sessionStorage: Array<{ name: string; value: string }>;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is BrowserStorageStateOrigin => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((origin) => ({
      origin: typeof origin.origin === 'string' ? origin.origin : '',
      localStorage: normalizeStorageEntries(origin.localStorage),
      sessionStorage: normalizeStorageEntries(origin.sessionStorage),
    }))
    .filter((origin) => origin.origin);
}

function normalizeStorageEntries(value: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is { name?: unknown; value?: unknown } => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name : '',
      value: typeof item.value === 'string' ? item.value : '',
    }))
    .filter((item) => item.name);
}

export function createBrowserArtifactSummary(args: {
  kind: 'download' | 'upload';
  artifactPath: string;
  mimeType: string | null;
  sessionId: string | null;
}): BrowserArtifactSummary {
  const stat = fs.statSync(args.artifactPath);
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(args.artifactPath));
  const sha256 = hash.digest('hex');
  const name = path.basename(args.artifactPath);
  return {
    artifactId: `${args.kind}_${Date.now()}_${sha256.slice(0, 12)}`,
    kind: args.kind,
    name,
    artifactPath: args.artifactPath,
    size: stat.size,
    mimeType: args.mimeType,
    sha256,
    createdAtMs: Date.now(),
    sessionId: args.sessionId,
  };
}

export function sanitizeArtifactFilename(value: string): string {
  const basename = path.basename(value).trim();
  const safe = basename
    .replace(/[^\w.+=@-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  return safe || `artifact_${Date.now()}`;
}

export function inferMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.txt':
      return 'text/plain';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.json':
      return 'application/json';
    case '.csv':
      return 'text/csv';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

export function sanitizeManagedBrowserId(value: string): string {
  const safe = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return safe || 'workspace';
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const target = path.resolve(targetPath);
  const root = path.resolve(rootPath);
  return target !== root && isPathWithinRoot(target, root);
}

export function redactBrowserWorkbenchTraceParams(toolName: string, params: Record<string, unknown>): Record<string, unknown> {
  const inputSafeParams = redactBrowserComputerInputArgs(toolName, params);
  if (inputSafeParams) {
    return inputSafeParams;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (/password|token|secret|credential|cookie/i.test(key)) {
      redacted[key] = '[redacted]';
    } else if (/profile(dir|path)|userDataDir|artifact(dir|path)|download(dir|path)|uploadFilePath|workspace(scope|path|root|dir|directory)|storageState/i.test(key)) {
      redacted[key] = summarizeLocalPathForTrace(value);
    } else if (typeof value === 'string') {
      const sanitized = redactBrowserComputerInputPayloadsInValue(toolName, params, value);
      redacted[key] = typeof sanitized === 'string' && sanitized.length > 500
        ? `${sanitized.slice(0, 500)}...`
        : sanitized;
    } else {
      redacted[key] = redactBrowserComputerInputPayloadsInValue(toolName, params, value);
    }
  }
  return redacted;
}

function summarizeLocalPathForTrace(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  return path.basename(trimmed) || '[path]';
}
