import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { getUserDataPath } from '../../platform/appPaths';
import { createLogger } from '../../services/infra/logger';
import { OAUTH_FLOW_TIMEOUT_MS } from '../oauth/oauthCoordinator';

const LARK_CLI_VERSION = '1.0.89';
const LARK_CLI_PROFILE = 'neo';
const LARK_CLI_SCOPE = 'offline_access im:message im:message.send_as_user';
const OUTPUT_LIMIT = 1024 * 1024;
const FEISHU_URL_PATTERN = /https:\/\/open\.feishu\.cn\/[^\s"'<>]+/u;
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');
const ADMIN_INSTALL_MESSAGE = '需联系企业应用管理员安装';

const logger = createLogger('FeishuLarkCli');

interface LarkCliStatus {
  connected: boolean;
  identity: string;
  user?: {
    openId?: string;
    name?: string;
  };
}

interface LarkCliDriverOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  npmExecutable?: string;
  timeoutMs?: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type RunningChild = ChildProcessByStdio<null, Readable, Readable>;

class LarkCliCommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode?: number | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LarkCliCommandError';
  }
}

function cleanedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.OPENCLAW_HOME;
  delete env.HERMES_HOME;
  return env;
}

function appendOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT);
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return parsed as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof LarkCliCommandError)) return undefined;
  const raw = `${error.stdout}\n${error.stderr}`;
  const jsonCode = raw.match(/"(?:code|error_code)"\s*:\s*"?([\w-]+)"?/iu)?.[1];
  return jsonCode ?? raw.match(/(?:code|error_code)[=:\s]+([\w-]+)/iu)?.[1];
}

function requiresAdminInstall(error: unknown): boolean {
  if (!(error instanceof LarkCliCommandError)) return false;
  const raw = `${error.stdout}\n${error.stderr}`;
  return Boolean(errorCode(error)) || /scope|permission|admin|tenant|免审|权限|企业|管理员|拒绝|denied|rejected/iu.test(raw);
}

function isMissingConfiguration(error: unknown): boolean {
  if (!(error instanceof LarkCliCommandError)) return false;
  const raw = `${error.message}\n${error.stdout}\n${error.stderr}`;
  const causeCode = error.cause && typeof error.cause === 'object' && 'code' in error.cause
    ? String(error.cause.code)
    : '';
  return causeCode === 'ENOENT' || /not_configured|profile\s+.+not found|not configured/iu.test(raw);
}

function translateConnectionError(error: unknown): Error {
  if (!requiresAdminInstall(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  logger.error('Feishu lark-cli authorization rejected', {
    errorCode: errorCode(error) ?? 'unknown',
  });
  return new Error(ADMIN_INSTALL_MESSAGE, { cause: error });
}

function waitForProcess(
  child: RunningChild,
  commandLabel: string,
  timeoutMs: number,
  onOutput?: (combinedOutput: string, child: RunningChild) => void,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const emitOutput = () => onOutput?.(stripAnsi(`${stdout}\n${stderr}`), child);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new LarkCliCommandError(
        `${commandLabel} timed out after ${timeoutMs}ms`,
        stdout,
        stderr,
      )));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
      emitOutput();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
      emitOutput();
    });
    child.once('error', (error) => {
      finish(() => reject(new LarkCliCommandError(
        `${commandLabel} could not start`,
        stdout,
        stderr,
        undefined,
        { cause: error },
      )));
    });
    child.once('close', (code) => {
      if (code === 0) {
        finish(() => resolve({ stdout, stderr }));
        return;
      }
      finish(() => reject(new LarkCliCommandError(
        `${commandLabel} failed with exit code ${code ?? 'unknown'}`,
        stdout,
        stderr,
        code,
      )));
    });
  });
}

export function createLarkCliDriver(options: LarkCliDriverOptions = {}) {
  const dataDir = options.dataDir ?? getUserDataPath();
  const installPrefix = path.join(dataDir, 'lark-cli');
  const packageDir = path.join(installPrefix, 'node_modules', '@larksuite', 'cli');
  const packageJsonPath = path.join(packageDir, 'package.json');
  const binaryPath = path.join(packageDir, 'bin', 'lark-cli');
  const env = cleanedEnv(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
  const npmExecutable = options.npmExecutable ?? 'npm';

  const run = (
    executable: string,
    args: string[],
    label: string,
    onOutput?: (combinedOutput: string, child: RunningChild) => void,
  ): Promise<CommandResult> => {
    const child = spawn(executable, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return waitForProcess(child, label, timeoutMs, onOutput);
  };

  const installedVersion = async (): Promise<string | undefined> => {
    try {
      const pkg = parseRecord(await readFile(packageJsonPath, 'utf8'), 'lark-cli package.json');
      return optionalString(pkg, 'version');
    } catch {
      return undefined;
    }
  };

  const hasExecutable = async (): Promise<boolean> => {
    try {
      await access(binaryPath, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  const ensureInstalled = async (): Promise<void> => {
    if (await installedVersion() === LARK_CLI_VERSION && await hasExecutable()) return;
    await mkdir(installPrefix, { recursive: true });
    await run(
      npmExecutable,
      ['install', '--prefix', installPrefix, `@larksuite/cli@${LARK_CLI_VERSION}`],
      'install lark-cli',
    );
    const version = await installedVersion();
    if (version !== LARK_CLI_VERSION || !(await hasExecutable())) {
      throw new Error(`lark-cli ${LARK_CLI_VERSION} installation could not be verified`);
    }
  };

  const status = async (): Promise<LarkCliStatus> => {
    try {
      const result = await run(
        binaryPath,
        ['auth', 'status', '--json', '--profile', LARK_CLI_PROFILE],
        'lark-cli auth status',
      );
      const parsed = parseRecord(result.stdout, 'lark-cli auth status');
      const identities = parsed.identities && typeof parsed.identities === 'object'
        ? parsed.identities as Record<string, unknown>
        : {};
      const userIdentity = identities.user && typeof identities.user === 'object'
        ? identities.user as Record<string, unknown>
        : {};
      const connected = userIdentity.available === true;
      const identity = optionalString(parsed, 'identity') ?? 'none';
      const openId = optionalString(userIdentity, 'openId');
      const name = optionalString(userIdentity, 'userName');
      return {
        connected,
        identity,
        ...(openId || name ? {
          user: {
            ...(openId ? { openId } : {}),
            ...(name ? { name } : {}),
          },
        } : {}),
      };
    } catch {
      return { connected: false, identity: 'none' };
    }
  };

  const connect = async (openExternal: (url: string) => void | Promise<void>): Promise<void> => {
    await ensureInstalled();
    try {
      try {
        await run(
          binaryPath,
          ['config', 'show', '--profile', LARK_CLI_PROFILE],
          'lark-cli config show',
        );
      } catch {
        let openedUrl: string | undefined;
        let openPromise: Promise<void> | undefined;
        let openError: unknown;
        let result: CommandResult;
        try {
          result = await run(
            binaryPath,
            ['config', 'init', '--new', '--lang', 'zh', '--name', LARK_CLI_PROFILE],
            'lark-cli config init',
            (output, child) => {
              if (openedUrl) return;
              const matched = output.match(FEISHU_URL_PATTERN)?.[0];
              if (!matched) return;
              openedUrl = matched;
              openPromise = Promise.resolve()
                .then(() => openExternal(matched))
                .catch((error: unknown) => {
                  openError = error;
                  child.kill('SIGTERM');
                });
            },
          );
        } catch (error) {
          await openPromise;
          if (openError) throw new Error('Could not open the Feishu setup URL', { cause: error });
          throw error;
        }
        const matched = openedUrl ?? stripAnsi(result.stdout).match(FEISHU_URL_PATTERN)?.[0];
        if (!matched) throw new Error('lark-cli config init did not return a Feishu setup URL');
        if (!openPromise) openPromise = Promise.resolve().then(() => openExternal(matched));
        await openPromise;
        if (openError) throw new Error('Could not open the Feishu setup URL', { cause: openError });
      }

      const login = await run(
        binaryPath,
        [
          'auth', 'login', '--no-wait', '--json',
          '--scope', LARK_CLI_SCOPE,
          '--profile', LARK_CLI_PROFILE,
        ],
        'lark-cli auth login',
      );
      const loginPayload = parseRecord(login.stdout, 'lark-cli auth login');
      const deviceCode = optionalString(loginPayload, 'device_code');
      const verificationUrl = optionalString(loginPayload, 'verification_url');
      if (!deviceCode || !verificationUrl) {
        throw new Error('lark-cli auth login did not return a device code');
      }
      await openExternal(verificationUrl);
      await run(
        binaryPath,
        ['auth', 'login', '--device-code', deviceCode, '--profile', LARK_CLI_PROFILE],
        'lark-cli device authorization',
      );
    } catch (error) {
      throw translateConnectionError(error);
    }
  };

  const disconnect = async (): Promise<void> => {
    try {
      await run(
        binaryPath,
        ['config', 'remove', '--profile', LARK_CLI_PROFILE],
        'lark-cli config remove',
      );
    } catch (error) {
      if (isMissingConfiguration(error)) return;
      throw error;
    }
  };

  return { ensureInstalled, status, connect, disconnect };
}
