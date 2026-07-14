// ============================================================================
// Shell Environment Capture
// Captures the user's full shell environment (PATH etc.) on startup
// Solves: desktop apps launched from Finder don't inherit shell PATH
// ============================================================================

import { execFile, execSync } from 'child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import { createLogger } from './logger';

const logger = createLogger('ShellEnvironment');

let shellEnv: Record<string, string> | null = null;
let shellPath: string | null = null;

const SHELL_ENV_CACHE_SCHEMA_VERSION = 1;
const SHELL_ENV_CACHE_FILE = 'shell-environment.json';

const SYSTEM_BASE_PATHS = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
const FALLBACK_CLI_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/Library/Apple/usr/bin',
];

export interface ShellPathDiagnostics {
  source: 'captured' | 'process' | 'empty';
  pathEntryCount: number;
  degraded: boolean;
  fallbackApplied: boolean;
  fallbackEntries: string[];
}

interface ShellPathResolution extends ShellPathDiagnostics {
  path: string;
}

interface ShellEnvironmentCache {
  schemaVersion: number;
  platform: NodeJS.Platform;
  shell: string;
  capturedAt: string;
  environment: Record<string, string>;
}

export interface LoadShellEnvironmentOptions {
  dataDir?: string;
}

function splitPath(value: string | undefined): string[] {
  return (value || '').split(':').filter(Boolean);
}

function mergePathEntries(...entryGroups: string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entries of entryGroups) {
    for (const entry of entries) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function isDegradedPath(entries: string[]): boolean {
  if (entries.length === 0) return true;
  return entries.every((entry) => SYSTEM_BASE_PATHS.has(entry));
}

function resolveShellPath(basePath: string | undefined, source: ShellPathDiagnostics['source']): ShellPathResolution {
  const baseEntries = splitPath(basePath);
  const degraded = isDegradedPath(baseEntries);
  const fallbackEntries = degraded
    ? FALLBACK_CLI_PATHS.filter((entry) => !baseEntries.includes(entry))
    : [];
  const mergedEntries = mergePathEntries(baseEntries, fallbackEntries);

  return {
    path: mergedEntries.join(':'),
    source,
    pathEntryCount: mergedEntries.length,
    degraded,
    fallbackApplied: fallbackEntries.length > 0,
    fallbackEntries,
  };
}

function parseShellEnvironment(output: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
      environment[line.substring(0, eqIndex)] = line.substring(eqIndex + 1);
    }
  }
  return environment;
}

function applyShellEnvironment(environment: Record<string, string>): number {
  shellEnv = environment;
  const uniquePaths = mergePathEntries(
    splitPath(environment.PATH),
    splitPath(process.env.PATH),
  );
  shellPath = uniquePaths.join(':');
  return uniquePaths.length;
}

export function resolveShellEnvironmentCachePath(dataDir?: string): string {
  const configuredDataDir = dataDir?.trim();
  const root = configuredDataDir ? path.resolve(configuredDataDir) : getUserConfigDir();
  return path.join(root, 'cache', SHELL_ENV_CACHE_FILE);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function readShellEnvironmentCache(cachePath: string, shell: string): ShellEnvironmentCache | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<ShellEnvironmentCache>;
    if (
      parsed.schemaVersion !== SHELL_ENV_CACHE_SCHEMA_VERSION
      || parsed.platform !== process.platform
      || parsed.shell !== shell
      || typeof parsed.capturedAt !== 'string'
      || !isStringRecord(parsed.environment)
    ) {
      return null;
    }
    return parsed as ShellEnvironmentCache;
  } catch {
    return null;
  }
}

function persistShellEnvironmentCache(
  cachePath: string,
  shell: string,
  environment: Record<string, string>,
): void {
  const cache: ShellEnvironmentCache = {
    schemaVersion: SHELL_ENV_CACHE_SCHEMA_VERSION,
    platform: process.platform,
    shell,
    capturedAt: new Date().toISOString(),
    environment,
  };
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    writeFileSync(tempPath, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, cachePath);
  } catch (error) {
    logger.warn('Failed to persist shell environment cache', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function refreshShellEnvironmentInBackground(shell: string, cachePath: string): void {
  execFile(shell, ['-i', '-l', '-c', 'env'], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env },
  }, (error, output) => {
    if (error) {
      logger.warn('Failed to refresh cached shell environment, keeping cached values', {
        shell,
        error: error.message,
      });
      return;
    }

    const environment = parseShellEnvironment(output);
    const pathEntries = applyShellEnvironment(environment);
    persistShellEnvironmentCache(cachePath, shell, environment);
    logger.info('Shell environment cache refreshed', { shell, pathEntries });
  });
}

/**
 * Load the user's shell environment
 * Only runs on macOS/Linux in desktop mode (not CLI mode)
 */
export function loadShellEnvironment(options: LoadShellEnvironmentOptions = {}): void {
  // Skip in pure CLI mode — CLI inherits the shell environment naturally.
  // Web mode sets CODE_AGENT_CLI_MODE for native-module safety, but still runs
  // from the desktop app and needs login shell PATH capture.
  if (process.env.CODE_AGENT_CLI_MODE && process.env.CODE_AGENT_WEB_MODE !== 'true') {
    logger.debug('CLI mode, skipping shell environment capture');
    return;
  }

  // Skip on Windows
  if (process.platform === 'win32') {
    logger.debug('Windows platform, skipping shell environment capture');
    return;
  }

  const shell = process.env.SHELL || '/bin/zsh';
  const cachePath = resolveShellEnvironmentCachePath(options.dataDir);
  const cached = readShellEnvironmentCache(cachePath, shell);
  if (cached) {
    const pathEntries = applyShellEnvironment(cached.environment);
    logger.info('Shell environment loaded from cache', { shell, pathEntries });
    refreshShellEnvironmentInBackground(shell, cachePath);
    return;
  }

  try {
    const output = execSync(`${shell} -i -l -c 'env'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const environment = parseShellEnvironment(output);
    const pathEntries = applyShellEnvironment(environment);
    persistShellEnvironmentCache(cachePath, shell, environment);

    logger.info('Shell environment captured', {
      shell,
      pathEntries,
    });
  } catch (error) {
    logger.warn('Failed to capture shell environment, using process.env', {
      shell,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get the merged shell PATH (shell env + process.env, deduplicated)
 * Falls back to process.env.PATH plus common macOS CLI directories if PATH
 * degraded to only system base paths.
 */
export function getShellPath(): string {
  return getShellPathDiagnostics().path;
}

export function getShellEnvironmentValue(key: string): string | undefined {
  return shellEnv?.[key];
}

/**
 * Resolve shell PATH with lightweight diagnostics for tool metadata.
 * Does not expose environment variables beyond fallback directory names.
 */
export function getShellPathDiagnostics(): ShellPathResolution {
  const source: ShellPathDiagnostics['source'] = shellPath ? 'captured' : process.env.PATH ? 'process' : 'empty';
  return resolveShellPath(shellPath || process.env.PATH || '', source);
}
