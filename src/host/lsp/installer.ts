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
import { execFile } from 'child_process';
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

// 子进程一律异步：这条路径在每次 run 启动时由 LSP 初始化调用，spawnSync 会把整个
// webServer 事件循环卡住数秒（槽 3 实测 npm install 3.4s，N-STARTUP-LOOP-STALL）。
function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeout: number },
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { ...options, shell: process.platform === 'win32' }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({
        status: error ? (typeof code === 'number' ? code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? (error ? error.message : '')),
      });
    });
  });
}

async function isCommandOnPath(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return (await runCommand(probe, [command], { timeout: LSP_TIMEOUTS.COMMAND_CHECK })).status === 0;
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

// 串行：多个服务器同时首装会在同一目录抢 npm 锁。
let installQueue: Promise<unknown> = Promise.resolve();

async function runNpmInstall(dir: string, packages: string[]): Promise<void> {
  // 不用 --no-save：装进同一目录的另一个服务器再 npm install 时，未写进 package.json 的包
  // 会被当成多余包删掉，两个服务器互相卸载、每次 run 都重装（槽 3 lsp-servers 只剩 pyright）。
  const install = installQueue.then(() => runCommand('npm', ['install', '--no-audit', '--no-fund', ...packages], {
    cwd: dir,
    timeout: LSP_TIMEOUTS.INSTALL,
  }));
  installQueue = install.catch(() => undefined);
  const result = await install;
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
  if (await isCommandOnPath(config.command)) {
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
      await runNpmInstall(installDir, config.install.packages);
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
