// ============================================================================
// Bubblewrap Sandbox - Linux process isolation using bwrap
// ============================================================================
//
// NOTE: This module intentionally uses child_process.spawn for sandbox execution.
// The spawn calls are safe because:
// 1. Commands are executed inside a sandboxed environment (bwrap)
// 2. User input is validated by commandSafety (validateCommand) before reaching here
// 3. The sandbox restricts what the command can access

import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { quote } from 'shell-quote';
import { createLogger } from '../services/infra/logger';
import { SANDBOX_TIMEOUTS } from '../../shared/constants';
import { getSensitiveSandboxPaths, type SensitiveSandboxPath } from './sensitivePaths';

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
  /** Sensitive host paths that must be masked when present in mounted trees */
  sensitivePaths?: SensitiveSandboxPath[];
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

interface PathStatLike {
  isDirectory: () => boolean;
  isFile: () => boolean;
}

export interface BuildSensitivePathMountArgsOptions {
  sensitivePaths?: SensitiveSandboxPath[];
  placeholderDir?: string;
  pathExists?: (targetPath: string) => boolean;
  statPath?: (targetPath: string) => PathStatLike;
  preparePlaceholder?: (targetPath: string, placeholderDir?: string) => string;
}

export function buildSensitivePathMountArgs(
  options: BuildSensitivePathMountArgsOptions = {},
): string[] {
  const args: string[] = [];
  const sensitivePaths = options.sensitivePaths ?? getSensitiveSandboxPaths();
  const pathExists = options.pathExists ?? ((targetPath: string) => fs.existsSync(targetPath));
  const statPath = options.statPath ?? ((targetPath: string) => fs.statSync(targetPath));
  const preparePlaceholder = options.preparePlaceholder ?? prepareReadDeniedPlaceholder;

  for (const entry of sensitivePaths) {
    const target = path.resolve(entry.path);
    if (entry.kind === 'directory') {
      validateSensitiveDirectoryTarget(target, pathExists, statPath);
      args.push('--tmpfs', target);
      continue;
    }

    validateSensitiveFileTarget(target, pathExists, statPath);
    let placeholder: string;
    try {
      placeholder = preparePlaceholder(target, options.placeholderDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to prepare sensitive path placeholder for ${target}: ${message}`, { cause: error });
    }
    args.push('--ro-bind', placeholder, target);
  }

  return args;
}

function validateSensitiveDirectoryTarget(
  target: string,
  pathExists: (targetPath: string) => boolean,
  statPath: (targetPath: string) => PathStatLike,
): void {
  if (!pathExists(target)) return;
  let stat: PathStatLike;
  try {
    stat = statPath(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to inspect sensitive directory ${target}: ${message}`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`Sensitive directory target is not a directory: ${target}`);
  }
}

function validateSensitiveFileTarget(
  target: string,
  pathExists: (targetPath: string) => boolean,
  statPath: (targetPath: string) => PathStatLike,
): void {
  if (!pathExists(target)) return;
  let stat: PathStatLike;
  try {
    stat = statPath(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to inspect sensitive file ${target}: ${message}`, { cause: error });
  }
  if (!stat.isFile()) {
    throw new Error(`Sensitive file target is not a file: ${target}`);
  }
}

function prepareReadDeniedPlaceholder(
  target: string,
  placeholderDir = path.join(os.tmpdir(), 'code-agent-bwrap-sensitive-deny'),
): string {
  fs.mkdirSync(placeholderDir, { recursive: true, mode: 0o700 });
  const digest = createHash('sha256').update(target).digest('hex').slice(0, 24);
  const placeholder = path.join(placeholderDir, `deny-${digest}`);

  if (fs.existsSync(placeholder)) {
    const stat = fs.statSync(placeholder);
    if (!stat.isFile()) {
      throw new Error(`placeholder is not a file: ${placeholder}`);
    }
    fs.chmodSync(placeholder, 0o600);
    fs.truncateSync(placeholder, 0);
  } else {
    const fd = fs.openSync(placeholder, 'wx', 0o600);
    fs.closeSync(fd);
  }

  fs.chmodSync(placeholder, 0o000);
  const finalStat = fs.statSync(placeholder);
  if (!finalStat.isFile()) {
    throw new Error(`placeholder is not a file after creation: ${placeholder}`);
  }
  if ((finalStat.mode & 0o777) !== 0) {
    throw new Error(`placeholder permissions are not 000: ${placeholder}`);
  }

  return placeholder;
}

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

    args.push(...buildSensitivePathMountArgs({
      sensitivePaths: config.sensitivePaths,
    }));

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
    return fs.existsSync(p);
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

      proc.stdout.on('data', (data: Buffer | string) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer | string) => {
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
   * 把命令包装成"带 bwrap 前缀"的单条 shell 命令字符串，交给外部执行器
   * （如 bash 工具的 runForegroundCommand）以 `spawn(cmd, { shell: true })` 运行。
   *
   * 与 execute() 的区别：不缓冲、不 spawn，只生成命令字符串。
   * cleanup 为 no-op（bwrap 无临时 profile 文件，与 seatbelt 接口对齐）。
   *
   * @throws bwrap 不可用时抛错（调用方负责在 bypass 档拒绝执行）
   */
  wrapCommand(
    command: string,
    config: Partial<BubblewrapConfig> = {}
  ): { command: string; cleanup: () => void } {
    const status = this.checkAvailability();
    if (!status.available) {
      throw new Error(status.error || 'bwrap unavailable');
    }
    const fullConfig: BubblewrapConfig = { ...DEFAULT_CONFIG, ...config };
    const bwrapArgs = this.buildArgs(fullConfig);
    const wrapped = quote(['bwrap', ...bwrapArgs, '--', '/bin/sh', '-c', command]);
    return { command: wrapped, cleanup: () => { /* no profile file to clean */ } };
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

      proc.stdout.on('data', (data: Buffer | string) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer | string) => {
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
