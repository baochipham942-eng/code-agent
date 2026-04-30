// ============================================================================
// LSP Server Installer
// ============================================================================
// Resolves the executable path for an LSP server, optionally installing it.
//
// Strategy:
//   1. If the configured command is on PATH, use it directly.
//   2. Otherwise, follow the `install` source:
//      - `npm`: install once into ~/.code-agent/lsp-servers/, return abs path.
//      - `system`: throw LSPInstallError with the user-facing install command.
// ============================================================================

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { getUserConfigDir } from '../config/configPaths';
import { LSP_TIMEOUTS } from '../../shared/constants/timeouts';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type LSPInstallSource =
  | { type: 'npm'; packages: string[]; binName: string }
  | { type: 'system'; installCmd: string; docUrl?: string };

export interface ResolvedCommand {
  /** Absolute path or PATH-resolvable command */
  command: string;
  /** Original args (unchanged) */
  args: string[];
  /** Whether install was triggered this call */
  installed: boolean;
}

export class LSPInstallError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly source: LSPInstallSource | undefined,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LSPInstallError';
  }
}

// ----------------------------------------------------------------------------
// Path helpers
// ----------------------------------------------------------------------------

export function getLSPInstallDir(): string {
  return path.join(getUserConfigDir(), 'lsp-servers');
}

function npmBinPath(installDir: string, binName: string): string {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return path.join(installDir, 'node_modules', '.bin', binName + ext);
}

// ----------------------------------------------------------------------------
// Probes
// ----------------------------------------------------------------------------

function isCommandOnPath(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(probe, [command], {
      stdio: 'pipe',
      shell: true,
      timeout: LSP_TIMEOUTS.COMMAND_CHECK,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// npm install
// ----------------------------------------------------------------------------

async function ensureNpmRoot(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const pkgJson = path.join(dir, 'package.json');
  if (!existsSync(pkgJson)) {
    await fs.writeFile(
      pkgJson,
      JSON.stringify({ name: 'code-agent-lsp-servers', private: true }, null, 2),
    );
  }
}

function runNpmInstall(dir: string, packages: string[]): void {
  const result = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', ...packages], {
    cwd: dir,
    stdio: 'pipe',
    shell: true,
    timeout: LSP_TIMEOUTS.INSTALL,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    const stdout = result.stdout?.toString() ?? '';
    throw new Error(
      `npm install ${packages.join(' ')} failed (status=${result.status}): ${stderr || stdout}`,
    );
  }
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export async function ensureInstalled(config: {
  name: string;
  command: string;
  args: string[];
  install?: LSPInstallSource;
}): Promise<ResolvedCommand> {
  if (isCommandOnPath(config.command)) {
    return { command: config.command, args: config.args, installed: false };
  }

  if (!config.install) {
    throw new LSPInstallError(
      config.name,
      undefined,
      `LSP server '${config.name}' not found on PATH and no installer configured`,
    );
  }

  if (config.install.type === 'npm') {
    const installDir = getLSPInstallDir();
    const binPath = npmBinPath(installDir, config.install.binName);

    if (existsSync(binPath)) {
      return { command: binPath, args: config.args, installed: false };
    }

    try {
      await ensureNpmRoot(installDir);
      runNpmInstall(installDir, config.install.packages);
    } catch (err) {
      throw new LSPInstallError(
        config.name,
        config.install,
        `Failed to install ${config.install.packages.join(', ')}`,
        err,
      );
    }

    if (!existsSync(binPath)) {
      throw new LSPInstallError(
        config.name,
        config.install,
        `npm install completed but bin '${config.install.binName}' not found at ${binPath}`,
      );
    }

    return { command: binPath, args: config.args, installed: true };
  }

  throw new LSPInstallError(
    config.name,
    config.install,
    `LSP server '${config.name}' must be installed manually. Run: ${config.install.installCmd}`,
  );
}
