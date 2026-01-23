// ============================================================================
// Sandbox Manager - Unified sandbox API with platform auto-detection
// ============================================================================

import * as os from 'os';
import { createLogger } from '../services/infra/logger';
import { getBubblewrap, type BubblewrapConfig, type BubblewrapStatus } from './bubblewrap';
import { getSeatbelt, type SeatbeltConfig, type SeatbeltStatus } from './seatbelt';

const logger = createLogger('SandboxManager');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Platform type
 */
export type SandboxPlatform = 'linux' | 'darwin' | 'unsupported';

/**
 * Unified sandbox configuration
 */
export interface SandboxConfig {
  /** Allow network access */
  allowNetwork: boolean;
  /** Paths with read access */
  readPaths: string[];
  /** Paths with write access */
  writePaths: string[];
  /** Working directory */
  workingDirectory?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Environment variables to pass through */
  envPassthrough?: string[];
  /** Custom environment variables */
  customEnv?: Record<string, string>;
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
  /** Whether execution timed out */
  timedOut: boolean;
  /** Whether sandbox was actually used */
  sandboxed: boolean;
  /** Platform used */
  platform: SandboxPlatform;
}

/**
 * Sandbox manager status
 */
export interface SandboxManagerStatus {
  /** Detected platform */
  platform: SandboxPlatform;
  /** Whether sandbox is available */
  available: boolean;
  /** Sandbox technology name */
  technology?: string;
  /** Technology version */
  version?: string;
  /** Error if not available */
  error?: string;
}

/**
 * Sandbox preset types
 */
export type SandboxPreset = 'minimal' | 'development' | 'network' | 'full';

// ----------------------------------------------------------------------------
// Default Configuration
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: SandboxConfig = {
  allowNetwork: false,
  readPaths: [],
  writePaths: [],
  timeout: 120000, // 2 minutes
  envPassthrough: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'],
  customEnv: {},
};

// ----------------------------------------------------------------------------
// Sandbox Manager Class
// ----------------------------------------------------------------------------

/**
 * Sandbox Manager - Unified sandbox interface
 *
 * Automatically detects the platform and uses the appropriate
 * sandboxing technology:
 * - Linux: Bubblewrap (bwrap)
 * - macOS: Seatbelt (sandbox-exec)
 *
 * Falls back to unsandboxed execution if no sandbox is available.
 */
export class SandboxManager {
  private platform: SandboxPlatform;
  private status: SandboxManagerStatus | null = null;
  private enabled = true;

  constructor() {
    this.platform = this.detectPlatform();
    logger.info('Sandbox manager initialized', { platform: this.platform });
  }

  /**
   * Detect the current platform
   */
  private detectPlatform(): SandboxPlatform {
    const platform = os.platform();
    if (platform === 'linux') return 'linux';
    if (platform === 'darwin') return 'darwin';
    return 'unsupported';
  }

  /**
   * Get sandbox status
   */
  getStatus(): SandboxManagerStatus {
    if (this.status) {
      return this.status;
    }

    switch (this.platform) {
      case 'linux': {
        const bwrapStatus: BubblewrapStatus = getBubblewrap().checkAvailability();
        this.status = {
          platform: 'linux',
          available: bwrapStatus.available,
          technology: 'Bubblewrap',
          version: bwrapStatus.version,
          error: bwrapStatus.error,
        };
        break;
      }

      case 'darwin': {
        const seatbeltStatus: SeatbeltStatus = getSeatbelt().checkAvailability();
        this.status = {
          platform: 'darwin',
          available: seatbeltStatus.available,
          technology: 'Seatbelt',
          version: seatbeltStatus.version,
          error: seatbeltStatus.error,
        };
        break;
      }

      default:
        this.status = {
          platform: 'unsupported',
          available: false,
          error: `Platform ${os.platform()} is not supported for sandboxing`,
        };
    }

    return this.status;
  }

  /**
   * Check if sandbox is available
   */
  isAvailable(): boolean {
    return this.getStatus().available;
  }

  /**
   * Enable sandboxing
   */
  enable(): void {
    this.enabled = true;
    logger.info('Sandbox enabled');
  }

  /**
   * Disable sandboxing
   */
  disable(): void {
    this.enabled = false;
    logger.info('Sandbox disabled');
  }

  /**
   * Check if sandboxing is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Execute a command in the sandbox
   *
   * @param command - Command to execute
   * @param config - Sandbox configuration
   * @returns Execution result
   */
  async execute(
    command: string,
    config: Partial<SandboxConfig> = {}
  ): Promise<SandboxResult> {
    const fullConfig: SandboxConfig = { ...DEFAULT_CONFIG, ...config };

    // If sandboxing is disabled, execute directly
    if (!this.enabled) {
      logger.debug('Sandbox disabled, executing directly');
      return this.executeUnsandboxed(command, fullConfig);
    }

    const status = this.getStatus();

    // If sandbox not available, execute directly with warning
    if (!status.available) {
      logger.warn('Sandbox not available, executing directly', {
        platform: status.platform,
        error: status.error,
      });
      return this.executeUnsandboxed(command, fullConfig);
    }

    // Execute with platform-specific sandbox
    switch (this.platform) {
      case 'linux':
        return this.executeWithBubblewrap(command, fullConfig);

      case 'darwin':
        return this.executeWithSeatbelt(command, fullConfig);

      default:
        return this.executeUnsandboxed(command, fullConfig);
    }
  }

  /**
   * Execute with Bubblewrap (Linux)
   */
  private async executeWithBubblewrap(
    command: string,
    config: SandboxConfig
  ): Promise<SandboxResult> {
    const bwrapConfig: Partial<BubblewrapConfig> = {
      allowNetwork: config.allowNetwork,
      readOnlyPaths: config.readPaths,
      readWritePaths: config.writePaths,
      workingDirectory: config.workingDirectory,
      timeout: config.timeout,
      envPassthrough: config.envPassthrough,
      customEnv: config.customEnv,
    };

    const result = await getBubblewrap().execute(command, bwrapConfig);

    return {
      ...result,
      platform: 'linux',
    };
  }

  /**
   * Execute with Seatbelt (macOS)
   */
  private async executeWithSeatbelt(
    command: string,
    config: SandboxConfig
  ): Promise<SandboxResult> {
    const seatbeltConfig: Partial<SeatbeltConfig> = {
      allowNetwork: config.allowNetwork,
      readPaths: config.readPaths,
      writePaths: config.writePaths,
      workingDirectory: config.workingDirectory,
      timeout: config.timeout,
      envPassthrough: config.envPassthrough,
      customEnv: config.customEnv,
    };

    const result = await getSeatbelt().execute(command, seatbeltConfig);

    return {
      ...result,
      platform: 'darwin',
    };
  }

  /**
   * Execute without sandbox (fallback)
   */
  private async executeUnsandboxed(
    command: string,
    config: SandboxConfig
  ): Promise<SandboxResult> {
    const { spawn } = await import('child_process');

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
          platform: this.platform,
        });
      });
    });
  }

  /**
   * Create a preset configuration
   */
  static createPreset(type: SandboxPreset): Partial<SandboxConfig> {
    switch (type) {
      case 'minimal':
        return {
          allowNetwork: false,
          readPaths: [],
          writePaths: [],
        };

      case 'development':
        return {
          allowNetwork: false,
          readPaths: [],
          writePaths: [],
          envPassthrough: [
            'PATH', 'HOME', 'USER', 'LANG', 'TERM',
            'NODE_ENV', 'npm_config_cache',
          ],
        };

      case 'network':
        return {
          allowNetwork: true,
          readPaths: [],
          writePaths: [],
        };

      case 'full':
        return {
          allowNetwork: true,
          readPaths: [],
          writePaths: [],
          envPassthrough: [
            'PATH', 'HOME', 'USER', 'LANG', 'TERM',
            'NODE_ENV', 'npm_config_cache', 'SHELL',
          ],
        };

      default:
        return {};
    }
  }

  /**
   * Create a configuration for a project directory
   */
  static forProject(
    projectDir: string,
    options: Partial<SandboxConfig> = {}
  ): Partial<SandboxConfig> {
    const path = require('path');
    const resolved = path.resolve(projectDir);

    return {
      ...options,
      readPaths: [...(options.readPaths || []), resolved],
      writePaths: [...(options.writePaths || []), resolved],
      workingDirectory: resolved,
    };
  }

  /**
   * Reset cached status (useful for testing)
   */
  resetStatus(): void {
    this.status = null;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let sandboxManagerInstance: SandboxManager | null = null;

/**
 * Get or create sandbox manager instance
 */
export function getSandboxManager(): SandboxManager {
  if (!sandboxManagerInstance) {
    sandboxManagerInstance = new SandboxManager();
  }
  return sandboxManagerInstance;
}

/**
 * Reset sandbox manager instance (for testing)
 */
export function resetSandboxManager(): void {
  sandboxManagerInstance = null;
}

/**
 * Convenience function to execute a command in sandbox
 */
export async function executeInSandbox(
  command: string,
  config?: Partial<SandboxConfig>
): Promise<SandboxResult> {
  return getSandboxManager().execute(command, config);
}
