// ============================================================================
// Shell Environment Capture
// Captures the user's full shell environment (PATH etc.) on startup
// Solves: Electron apps launched from Finder don't inherit shell PATH
// ============================================================================

import { execSync } from 'child_process';
import { createLogger } from './logger';

const logger = createLogger('ShellEnvironment');

let shellEnv: Record<string, string> | null = null;
let shellPath: string | null = null;

/**
 * Load the user's shell environment
 * Only runs on macOS/Linux in Electron mode (not CLI mode)
 */
export function loadShellEnvironment(): void {
  // Skip in CLI mode — CLI inherits the shell environment naturally
  if (process.env.CODE_AGENT_CLI_MODE) {
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
    const allPaths = `${shellPathValue}:${processPath}`.split(':');
    const seen = new Set<string>();
    const uniquePaths: string[] = [];
    for (const p of allPaths) {
      if (p && !seen.has(p)) {
        seen.add(p);
        uniquePaths.push(p);
      }
    }
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
 * Falls back to process.env.PATH if shell env not captured
 */
export function getShellPath(): string {
  return shellPath || process.env.PATH || '';
}
