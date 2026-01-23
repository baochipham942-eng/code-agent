// ============================================================================
// Seatbelt Sandbox - macOS process isolation using sandbox-exec
// ============================================================================
//
// NOTE: This module intentionally uses child_process.spawn for sandbox execution.
// The spawn calls are safe because:
// 1. Commands are executed inside a sandboxed environment (sandbox-exec)
// 2. User input is validated by CommandMonitor before reaching here
// 3. The sandbox restricts what the command can access

import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('Seatbelt');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Seatbelt configuration for sandbox execution
 */
export interface SeatbeltConfig {
  /** Allow network access (default: false) */
  allowNetwork: boolean;
  /** Paths to allow read access */
  readPaths: string[];
  /** Paths to allow write access */
  writePaths: string[];
  /** Paths to allow execute access */
  executePaths: string[];
  /** Allow process execution (default: true) */
  allowProcessExec: boolean;
  /** Allow process forking (default: true) */
  allowProcessFork: boolean;
  /** Environment variables to pass through */
  envPassthrough: string[];
  /** Custom environment variables */
  customEnv: Record<string, string>;
  /** Working directory */
  workingDirectory?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Custom Seatbelt profile (overrides generated profile) */
  customProfile?: string;
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
  /** Whether sandbox was used */
  sandboxed: boolean;
}

/**
 * Seatbelt availability status
 */
export interface SeatbeltStatus {
  available: boolean;
  version?: string;
  error?: string;
}

// ----------------------------------------------------------------------------
// Default Configuration
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: SeatbeltConfig = {
  allowNetwork: false,
  readPaths: [
    '/usr',
    '/bin',
    '/sbin',
    '/Library/Frameworks',
    '/System/Library',
    '/private/var/db/timezone',
    '/private/etc/hosts',
    '/private/etc/resolv.conf',
    '/private/etc/ssl',
    '/private/etc/localtime',
  ],
  writePaths: [],
  executePaths: [
    '/usr/bin',
    '/bin',
    '/sbin',
    '/usr/sbin',
    '/usr/local/bin',
  ],
  allowProcessExec: true,
  allowProcessFork: true,
  envPassthrough: [
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL',
    'TERM',
    'SHELL',
    'TMPDIR',
  ],
  customEnv: {},
  timeout: 120000, // 2 minutes default
};

// ----------------------------------------------------------------------------
// Seatbelt Profile Templates
// ----------------------------------------------------------------------------

/**
 * Generate a Seatbelt profile from configuration
 */
function generateProfile(config: SeatbeltConfig): string {
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '',
    '; Allow sysctl for basic system info',
    '(allow sysctl-read)',
    '',
    '; Allow mach lookups for system services',
    '(allow mach-lookup)',
    '',
  ];

  // Process execution
  if (config.allowProcessExec) {
    lines.push('; Allow process execution');
    lines.push('(allow process-exec)');
    lines.push('');
  }

  // Process forking
  if (config.allowProcessFork) {
    lines.push('; Allow process forking');
    lines.push('(allow process-fork)');
    lines.push('');
  }

  // Network access
  if (config.allowNetwork) {
    lines.push('; Allow network access');
    lines.push('(allow network*)');
    lines.push('');
  } else {
    lines.push('; Deny network access');
    lines.push('(deny network*)');
    lines.push('');
  }

  // Read paths
  if (config.readPaths.length > 0) {
    lines.push('; Allow read access');
    for (const p of config.readPaths) {
      lines.push(`(allow file-read* (subpath "${escapeProfileString(p)}"))`);
    }
    lines.push('');
  }

  // Write paths
  if (config.writePaths.length > 0) {
    lines.push('; Allow write access');
    for (const p of config.writePaths) {
      lines.push(`(allow file-write* (subpath "${escapeProfileString(p)}"))`);
      // Also need read access to write
      lines.push(`(allow file-read* (subpath "${escapeProfileString(p)}"))`);
    }
    lines.push('');
  }

  // Execute paths
  if (config.executePaths.length > 0) {
    lines.push('; Allow execute access');
    for (const p of config.executePaths) {
      lines.push(`(allow file-read* (subpath "${escapeProfileString(p)}"))`);
    }
    lines.push('');
  }

  // Allow reading temp directory
  const tmpDir = process.env.TMPDIR || '/tmp';
  lines.push('; Allow temp directory access');
  lines.push(`(allow file-read* (subpath "${escapeProfileString(tmpDir)}"))`);
  lines.push(`(allow file-write* (subpath "${escapeProfileString(tmpDir)}"))`);
  lines.push('');

  // Allow basic file operations needed by most commands
  lines.push('; Allow basic file metadata operations');
  lines.push('(allow file-read-metadata)');
  lines.push('');

  // Allow signal handling
  lines.push('; Allow signal handling');
  lines.push('(allow signal (target self))');
  lines.push('');

  return lines.join('\n');
}

/**
 * Escape special characters in profile strings
 */
function escapeProfileString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ----------------------------------------------------------------------------
// Seatbelt Class
// ----------------------------------------------------------------------------

/**
 * Seatbelt Sandbox - macOS process isolation
 *
 * Uses sandbox-exec to create isolated execution environments.
 * Falls back to direct execution if sandbox-exec is not available.
 *
 * @see https://reverse.put.as/wp-content/uploads/2011/09/Apple-Sandbox-Guide-v1.0.pdf
 */
export class Seatbelt {
  private status: SeatbeltStatus | null = null;
  private tempProfileDir: string;

  constructor() {
    this.tempProfileDir = path.join(os.tmpdir(), 'code-agent-sandbox');
    this.ensureTempDir();
  }

  /**
   * Ensure temp directory exists
   */
  private ensureTempDir(): void {
    try {
      if (!fs.existsSync(this.tempProfileDir)) {
        fs.mkdirSync(this.tempProfileDir, { recursive: true });
      }
    } catch (error) {
      logger.warn('Failed to create temp profile directory', { error });
    }
  }

  /**
   * Check if seatbelt is available on the system
   */
  checkAvailability(): SeatbeltStatus {
    if (this.status) {
      return this.status;
    }

    // Only available on macOS
    if (os.platform() !== 'darwin') {
      this.status = {
        available: false,
        error: 'Seatbelt is only available on macOS',
      };
      return this.status;
    }

    try {
      // Check if sandbox-exec exists
      execSync('which sandbox-exec', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      // Get macOS version for compatibility info
      const macVersion = execSync('sw_vers -productVersion', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      this.status = {
        available: true,
        version: `macOS ${macVersion}`,
      };

      logger.info('Seatbelt available', { version: this.status.version });
      return this.status;
    } catch (error) {
      this.status = {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error checking sandbox-exec',
      };
      logger.warn('Seatbelt not available', { error: this.status.error });
      return this.status;
    }
  }

  /**
   * Write profile to temp file and return path
   */
  private writeProfile(profile: string): string {
    const profileId = `profile-${Date.now()}-${crypto.randomUUID().split('-')[0]}`;
    const profilePath = path.join(this.tempProfileDir, `${profileId}.sb`);

    fs.writeFileSync(profilePath, profile, 'utf-8');

    // Clean up old profiles (keep last 10)
    this.cleanupOldProfiles();

    return profilePath;
  }

  /**
   * Clean up old profile files
   */
  private cleanupOldProfiles(): void {
    try {
      const files = fs.readdirSync(this.tempProfileDir)
        .filter(f => f.endsWith('.sb'))
        .map(f => ({
          name: f,
          path: path.join(this.tempProfileDir, f),
          time: fs.statSync(path.join(this.tempProfileDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.time - a.time);

      // Keep only the 10 most recent
      for (const file of files.slice(10)) {
        try {
          fs.unlinkSync(file.path);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch {
      // Ignore cleanup errors
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
    config: Partial<SeatbeltConfig> = {}
  ): Promise<SandboxResult> {
    const fullConfig: SeatbeltConfig = { ...DEFAULT_CONFIG, ...config };
    const status = this.checkAvailability();

    // If sandbox-exec is not available, execute directly with warning
    if (!status.available) {
      logger.warn('Executing without sandbox', { reason: status.error });
      return this.executeUnsandboxed(command, fullConfig);
    }

    // Generate or use custom profile
    const profile = fullConfig.customProfile || generateProfile(fullConfig);
    const profilePath = this.writeProfile(profile);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      // Build environment
      const env: Record<string, string> = {};
      for (const envVar of fullConfig.envPassthrough) {
        const value = process.env[envVar];
        if (value !== undefined) {
          env[envVar] = value;
        }
      }
      Object.assign(env, fullConfig.customEnv);

      // Execute with sandbox-exec
      const proc = spawn('sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', command], {
        cwd: fullConfig.workingDirectory,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
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
        this.cleanupProfile(profilePath);
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
        this.cleanupProfile(profilePath);
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
   * Clean up a profile file
   */
  private cleanupProfile(profilePath: string): void {
    try {
      if (fs.existsSync(profilePath)) {
        fs.unlinkSync(profilePath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Execute without sandbox (fallback)
   */
  private async executeUnsandboxed(
    command: string,
    config: SeatbeltConfig
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
  ): Partial<SeatbeltConfig> {
    switch (type) {
      case 'minimal':
        return {
          allowNetwork: false,
          readPaths: ['/usr', '/bin', '/sbin'],
          writePaths: [],
          executePaths: ['/usr/bin', '/bin'],
        };

      case 'development':
        return {
          allowNetwork: false,
          readPaths: [
            ...DEFAULT_CONFIG.readPaths,
            '/usr/local',
            '/opt/homebrew',
          ],
          writePaths: [],
          executePaths: [
            ...DEFAULT_CONFIG.executePaths,
            '/usr/local/bin',
            '/opt/homebrew/bin',
          ],
        };

      case 'network':
        return {
          allowNetwork: true,
          readPaths: DEFAULT_CONFIG.readPaths,
          writePaths: [],
          executePaths: DEFAULT_CONFIG.executePaths,
        };

      case 'full':
        return {
          allowNetwork: true,
          readPaths: [
            ...DEFAULT_CONFIG.readPaths,
            '/usr/local',
            '/opt/homebrew',
            '/Applications',
          ],
          writePaths: [],
          executePaths: [
            ...DEFAULT_CONFIG.executePaths,
            '/usr/local/bin',
            '/opt/homebrew/bin',
          ],
        };

      default:
        return {};
    }
  }

  /**
   * Add a project directory to the sandbox with read-write access
   */
  static withProjectDir(
    config: Partial<SeatbeltConfig>,
    projectDir: string
  ): Partial<SeatbeltConfig> {
    const resolved = path.resolve(projectDir);
    return {
      ...config,
      readPaths: [...(config.readPaths || []), resolved],
      writePaths: [...(config.writePaths || []), resolved],
      workingDirectory: resolved,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let seatbeltInstance: Seatbelt | null = null;

/**
 * Get or create Seatbelt instance
 */
export function getSeatbelt(): Seatbelt {
  if (!seatbeltInstance) {
    seatbeltInstance = new Seatbelt();
  }
  return seatbeltInstance;
}

/**
 * Reset Seatbelt instance (for testing)
 */
export function resetSeatbelt(): void {
  seatbeltInstance = null;
}
