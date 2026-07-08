// ============================================================================
// Shell Environment Capture
// Captures the user's full shell environment (PATH etc.) on startup
// Solves: desktop apps launched from Finder don't inherit shell PATH
// ============================================================================

import { execSync } from 'child_process';
import { createLogger } from './logger';

const logger = createLogger('ShellEnvironment');

let shellEnv: Record<string, string> | null = null;
let shellPath: string | null = null;

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

/**
 * Load the user's shell environment
 * Only runs on macOS/Linux in desktop mode (not CLI mode)
 */
export function loadShellEnvironment(): void {
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

  try {
    const output = execSync(`${shell} -i -l -c 'env'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    shellEnv = {};
    for (const line of output.split('\n')) {
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0) {
        const key = line.substring(0, eqIndex);
        const value = line.substring(eqIndex + 1);
        shellEnv[key] = value;
      }
    }

    // Merge and deduplicate PATH
    const shellPathValue = shellEnv.PATH || '';
    const processPath = process.env.PATH || '';
    const uniquePaths = mergePathEntries(splitPath(shellPathValue), splitPath(processPath));
    shellPath = uniquePaths.join(':');

    logger.info('Shell environment captured', {
      shell,
      pathEntries: uniquePaths.length,
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
