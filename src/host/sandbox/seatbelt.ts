// ============================================================================
// Seatbelt Sandbox - macOS process isolation using sandbox-exec
// ============================================================================
//
// NOTE: This module intentionally uses child_process.spawn for sandbox execution.
// The spawn calls are safe because:
// 1. Commands are executed inside a sandboxed environment (sandbox-exec)
// 2. User input is validated by commandSafety (validateCommand) before reaching here
// 3. The sandbox restricts what the command can access

import { spawn, execSync, execFileSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { quote } from 'shell-quote';
import { createLogger } from '../services/infra/logger';
import { SANDBOX_TIMEOUTS } from '../../shared/constants';
import { getSensitiveSandboxPaths, type SensitiveSandboxPath } from './sensitivePaths';

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
  /** Sensitive host paths that must be denied even under allow-default read model */
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
  timeout: SANDBOX_TIMEOUTS.DEFAULT,
};

// ----------------------------------------------------------------------------
// Seatbelt Profile Templates
// ----------------------------------------------------------------------------

/**
 * Generate a Seatbelt profile from configuration
 *
 * 约束模型：「读放开 + 锁写/网络」（与 ASRT 的实践思路一致）。
 *
 * 为什么不是 deny-default + 限定 readPaths：macOS 上进程启动需读取 dyld 共享缓存等
 * 大量系统路径，deny-default 会令 /bin/sh 在动态链接阶段就 SIGABRT（已实测）。而读并非
 * 主要 blast-radius（应用层 Read 工具本就能读，且 policyEngine 另有 block-ssh-keys 等读规则），
 * 真正要防的是写到工作目录外 / `rm -rf ~` / 数据外泄。故：默认 allow，再收紧 file-write 与网络。
 *
 * 注意：seatbelt 的 subpath 按 realpath 匹配，必须解析符号链接（/var→/private/var、
 * /tmp→/private/tmp），否则放行规则匹配不上真实路径导致工作目录内写入也被拒（已实测）。
 *
 * config.readPaths / executePaths / allowProcessExec / allowProcessFork 在本模型下不再用于
 * 限制（allow default 已覆盖），保留字段仅为兼容历史调用方。read 收紧留作 v2。
 */
export function generateProfile(config: SeatbeltConfig): string {
  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    '',
  ];

  const sensitivePaths = config.sensitivePaths ?? getSensitiveSandboxPaths();
  if (sensitivePaths.length > 0) {
    lines.push('; Deny sensitive host reads');
    for (const entry of sensitivePaths) {
      const resolved = realPath(entry.path);
      if (entry.kind === 'directory') {
        lines.push(`(deny file-read* (subpath "${escapeProfileString(resolved)}"))`);
      } else {
        lines.push(`(deny file-read* (literal "${escapeProfileString(resolved)}"))`);
      }
    }
    lines.push('');
  }

  // Network：bypass 档放行；显式关闭时 deny
  if (!config.allowNetwork) {
    lines.push('; Deny network access');
    lines.push('(deny network*)');
    lines.push('');
  }

  // Writes：默认全拒，再按 realpath 放行 /dev + 临时目录 + 工作目录/显式写路径
  lines.push('; Confine writes: deny all, re-allow specific real paths');
  lines.push('(deny file-write*)');
  lines.push('(allow file-write* (subpath "/dev"))');

  const writeRoots = new Set<string>();
  writeRoots.add(realPath(process.env.TMPDIR || os.tmpdir() || '/tmp'));
  if (config.workingDirectory) writeRoots.add(realPath(config.workingDirectory));
  for (const p of config.writePaths) writeRoots.add(realPath(p));

  for (const p of writeRoots) {
    lines.push(`(allow file-write* (subpath "${escapeProfileString(p)}"))`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * 解析符号链接到真实路径（seatbelt subpath 按 realpath 匹配）。路径不存在时回退到 resolve。
 */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
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

  private preflightProfile(profilePath: string): void {
    try {
      execFileSync('sandbox-exec', ['-f', profilePath, '/usr/bin/true'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`sandbox-exec profile preflight failed: ${message}`, { cause: error });
    }
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
    try {
      this.preflightProfile(profilePath);
    } catch (error) {
      this.cleanupProfile(profilePath);
      throw error;
    }

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

      proc.stdout.on('data', (data: Buffer | string) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer | string) => {
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
   * 把命令包装成"带 sandbox-exec 前缀"的单条 shell 命令字符串，交给外部执行器
   * （如 bash 工具的 runForegroundCommand）以 `spawn(cmd, { shell: true })` 运行。
   *
   * 与 execute() 的区别：不缓冲、不 spawn，只生成命令 + 返回清理句柄。
   * 由此复用外部执行器已有的流式输出 / abort / 错误语义，能力白嫖。
   *
   * @throws sandbox-exec 不可用时抛错（调用方负责在 bypass 档拒绝执行）
   */
  wrapCommand(
    command: string,
    config: Partial<SeatbeltConfig> = {}
  ): { command: string; cleanup: () => void } {
    const status = this.checkAvailability();
    if (!status.available) {
      throw new Error(status.error || 'sandbox-exec unavailable');
    }
    const fullConfig: SeatbeltConfig = { ...DEFAULT_CONFIG, ...config };
    const profile = fullConfig.customProfile || generateProfile(fullConfig);
    const profilePath = this.writeProfile(profile);
    try {
      this.preflightProfile(profilePath);
    } catch (error) {
      this.cleanupProfile(profilePath);
      throw error;
    }
    // 用 shell-quote 把整个 argv 拼成安全字符串：原命令作为单一 token 交给内层 /bin/sh -c。
    const wrapped = quote(['sandbox-exec', '-f', profilePath, '/bin/sh', '-c', command]);
    return { command: wrapped, cleanup: () => this.cleanupProfile(profilePath) };
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
