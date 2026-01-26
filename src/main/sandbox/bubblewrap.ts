// ============================================================================
// Bubblewrap Sandbox - Linux process isolation using bwrap
// ============================================================================
//
// NOTE: This module intentionally uses child_process.spawn for sandbox execution.
// The spawn calls are safe because:
// 1. Commands are executed inside a sandboxed environment (bwrap)
// 2. User input is validated by CommandMonitor before reaching here
// 3. The sandbox restricts what the command can access

import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../services/infra/logger';
import { SANDBOX_TIMEOUTS } from '../../shared/constants';

const logger = createLogger('Bubblewrap');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Bubblewrap configuration for sandbox execution
 */
export interface BubblewrapConfig {
  /** Allow network access (default: false) */
  allowNetwork: boolean;
  /** Paths to mount read-only */
  readOnlyPaths: string[];
  /** Paths to mount read-write */
  readWritePaths: string[];
  /** Paths to mount as tmpfs (ephemeral) */
  tmpfsPaths: string[];
  /** Unshare all namespaces (default: true) */
  unshareAll: boolean;
  /** Die when parent process dies (default: true) */
  dieWithParent: boolean;
  /** Environment variables to pass through */
  envPassthrough: string[];
  /** Custom environment variables */
  customEnv: Record<string, string>;
  /** Working directory inside sandbox */
  workingDirectory?: string;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Sandbox execution result
 */
export interface SandboxResult {
  /** Exit code of the command */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Whether execution was killed due to timeout */
  timedOut: boolean;
  /** Whether sandbox was used (false if bwrap unavailable) */
  sandboxed: boolean;
}

/**
 * Bubblewrap availability status
 */
export interface BubblewrapStatus {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

// ----------------------------------------------------------------------------
// Default Configuration
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: BubblewrapConfig = {
  allowNetwork: false,
  readOnlyPaths: [
    '/usr',
    '/lib',
    '/lib64',
    '/bin',
    '/sbin',
    '/etc/alternatives',
    '/etc/ssl',
    '/etc/ca-certificates',
    '/etc/resolv.conf',
    '/etc/hosts',
    '/etc/passwd',
    '/etc/group',
    '/etc/nsswitch.conf',
  ],
  readWritePaths: [],
  tmpfsPaths: ['/tmp', '/var/tmp'],
  unshareAll: true,
  dieWithParent: true,
  envPassthrough: [
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL',
    'TERM',
    'SHELL',
  ],
  customEnv: {},
  timeout: SANDBOX_TIMEOUTS.DEFAULT,
};

// ----------------------------------------------------------------------------
// Bubblewrap Class
// ----------------------------------------------------------------------------

/**
 * Bubblewrap Sandbox - Linux process isolation
 *
 * Uses bubblewrap (bwrap) to create isolated execution environments.
 * Falls back to direct execution if bwrap is not available.
 *
 * @see https://github.com/containers/bubblewrap
 */
export class Bubblewrap {
  private status: BubblewrapStatus | null = null;

  /**
   * Check if bubblewrap is available on the system
   */
  checkAvailability(): BubblewrapStatus {
    if (this.status) {
      return this.status;
    }

    // Only available on Linux
    if (os.platform() !== 'linux') {
      this.status = {
        available: false,
        error: 'Bubblewrap is only available on Linux',
      };
      return this.status;
    }

    try {
      // Try to find bwrap
      const bwrapPath = execSync('which bwrap 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (!bwrapPath) {
        this.status = {
          available: false,
          error: 'bwrap not found in PATH',
        };
        return this.status;
      }

      // Get version
      const version = execSync('bwrap --version 2>&1', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      this.status = {
        available: true,
        version,
        path: bwrapPath,
      };

      logger.info('Bubblewrap available', { version, path: bwrapPath });
      return this.status;
    } catch (error) {
      this.status = {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error checking bwrap',
      };
      logger.warn('Bubblewrap not available', { error: this.status.error });
      return this.status;
    }
  }

  /**
   * Build bwrap command arguments
   */
  private buildArgs(config: BubblewrapConfig): string[] {
    const args: string[] = [];

    // Namespace isolation
    if (config.unshareAll) {
      args.push('--unshare-all');
      // Re-share network if allowed
      if (config.allowNetwork) {
        args.push('--share-net');
      }
    } else if (!config.allowNetwork) {
      args.push('--unshare-net');
    }

    // Die with parent
    if (config.dieWithParent) {
      args.push('--die-with-parent');
    }

    // Create new session
    args.push('--new-session');

    // Mount /proc (needed for many commands)
    args.push('--proc', '/proc');

    // Mount /dev
    args.push('--dev', '/dev');

    // Read-only mounts
    for (const p of config.readOnlyPaths) {
      if (this.pathExists(p)) {
        args.push('--ro-bind', p, p);
      }
    }

    // Read-write mounts
    for (const p of config.readWritePaths) {
      if (this.pathExists(p)) {
        args.push('--bind', p, p);
      }
    }

    // Tmpfs mounts
    for (const p of config.tmpfsPaths) {
      args.push('--tmpfs', p);
    }

    // Environment variables passthrough
    for (const envVar of config.envPassthrough) {
      const value = process.env[envVar];
      if (value !== undefined) {
        args.push('--setenv', envVar, value);
      }
    }

    // Custom environment variables
    for (const [key, value] of Object.entries(config.customEnv)) {
      args.push('--setenv', key, value);
    }

    // Working directory
    if (config.workingDirectory) {
      args.push('--chdir', config.workingDirectory);
    }

    return args;
  }

  /**
   * Check if a path exists
   */
  private pathExists(p: string): boolean {
    try {
      execSync(`test -e ${JSON.stringify(p)}`, { timeout: 1000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a command in the sandbox
   *
   * @param command - Command to execute
   * @param config - Partial configuration (merged with defaults)
   * @returns Execution result
   */
  async execute(
    command: string,
    config: Partial<BubblewrapConfig> = {}
  ): Promise<SandboxResult> {
    const fullConfig: BubblewrapConfig = { ...DEFAULT_CONFIG, ...config };
    const status = this.checkAvailability();

    // If bwrap is not available, execute directly with warning
    if (!status.available) {
      logger.warn('Executing without sandbox', { reason: status.error });
      return this.executeUnsandboxed(command, fullConfig);
    }

    const bwrapArgs = this.buildArgs(fullConfig);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      // Build full command: bwrap [args] -- /bin/sh -c "command"
      const proc = spawn('bwrap', [...bwrapArgs, '--', '/bin/sh', '-c', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {}, // Start with clean env, bwrap will set what we specified
      });

      // Handle timeout
      if (fullConfig.timeout) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGKILL');
        }, fullConfig.timeout);
      }

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        logger.error('Sandbox execution error', error);
        resolve({
          exitCode: -1,
          stdout,
          stderr: stderr + '\n' + error.message,
          timedOut: false,
          sandboxed: true,
        });
      });

      proc.on('close', (exitCode) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        logger.debug('Sandbox execution complete', {
          exitCode,
          timedOut,
          stdoutLength: stdout.length,
        });
        resolve({
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
          timedOut,
          sandboxed: true,
        });
      });
    });
  }

  /**
   * Execute without sandbox (fallback)
   */
  private async executeUnsandboxed(
    command: string,
    config: BubblewrapConfig
  ): Promise<SandboxResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const proc = spawn('/bin/sh', ['-c', command], {
        cwd: config.workingDirectory,
        env: {
          ...process.env,
          ...config.customEnv,
        },
      });

      if (config.timeout) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGKILL');
        }, config.timeout);
      }

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (exitCode) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve({
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
          timedOut,
          sandboxed: false,
        });
      });
    });
  }

  /**
   * Create a preset configuration for common use cases
   */
  static createPreset(
    type: 'minimal' | 'development' | 'network' | 'full'
  ): Partial<BubblewrapConfig> {
    switch (type) {
      case 'minimal':
        return {
          allowNetwork: false,
          readOnlyPaths: ['/usr', '/lib', '/lib64', '/bin', '/sbin'],
          readWritePaths: [],
          tmpfsPaths: ['/tmp'],
        };

      case 'development':
        return {
          allowNetwork: false,
          readOnlyPaths: [
            ...DEFAULT_CONFIG.readOnlyPaths,
            '/usr/share',
          ],
          readWritePaths: [],
          tmpfsPaths: ['/tmp', '/var/tmp'],
          envPassthrough: [
            ...DEFAULT_CONFIG.envPassthrough,
            'NODE_ENV',
            'npm_config_cache',
          ],
        };

      case 'network':
        return {
          allowNetwork: true,
          readOnlyPaths: DEFAULT_CONFIG.readOnlyPaths,
          readWritePaths: [],
          tmpfsPaths: ['/tmp'],
        };

      case 'full':
        return {
          allowNetwork: true,
          readOnlyPaths: [
            ...DEFAULT_CONFIG.readOnlyPaths,
            '/usr/share',
            '/opt',
          ],
          readWritePaths: [],
          tmpfsPaths: ['/tmp', '/var/tmp'],
        };

      default:
        return {};
    }
  }

  /**
   * Add a project directory to the sandbox with read-write access
   */
  static withProjectDir(
    config: Partial<BubblewrapConfig>,
    projectDir: string
  ): Partial<BubblewrapConfig> {
    const resolved = path.resolve(projectDir);
    return {
      ...config,
      readWritePaths: [...(config.readWritePaths || []), resolved],
      workingDirectory: resolved,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let bubblewrapInstance: Bubblewrap | null = null;

/**
 * Get or create Bubblewrap instance
 */
export function getBubblewrap(): Bubblewrap {
  if (!bubblewrapInstance) {
    bubblewrapInstance = new Bubblewrap();
  }
  return bubblewrapInstance;
}

/**
 * Reset Bubblewrap instance (for testing)
 */
export function resetBubblewrap(): void {
  bubblewrapInstance = null;
}
