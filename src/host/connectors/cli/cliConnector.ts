import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import * as pty from 'node-pty';
import { getUserDataPath } from '../../platform/appPaths';
import { createLogger } from '../../services/infra/logger';
import { OAUTH_FLOW_TIMEOUT_MS } from '../oauth/oauthCoordinator';
import type { CliConnectorDescriptor } from '../../../shared/contract/cliConnectorDescriptor';

const OUTPUT_LIMIT = 1024 * 1024;
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');
type CliCommandDescriptor = CliConnectorDescriptor['logout'];
type CliErrorMapping = CliConnectorDescriptor['errorMappings'][number];
type CliPtyUrlAuthStep = Extract<CliConnectorDescriptor['authSteps'][number], { kind: 'pty-url' }>;

interface CliConnectorOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  npmExecutable?: string;
  timeoutMs?: number;
  statusCacheTtlMs?: number;
  statusTimeoutMs?: number;
  now?: () => number;
}

export interface CliConnectorStatus {
  connected: boolean;
  identity: string;
  stale?: boolean;
  user?: {
    openId?: string;
    name?: string;
    tenantName?: string;
  };
}

interface CliStatusCache {
  value?: CliConnectorStatus;
  expiresAt: number;
  generation: number;
  inFlight?: Promise<CliConnectorStatus>;
  now: () => number;
}

const STATUS_CACHE_TTL_MS = 30_000;
const STATUS_TIMEOUT_MS = 4_000;
const statusCaches = new Map<string, CliStatusCache>();

export function getCachedStatus(providerId: string): CliConnectorStatus | undefined {
  const cache = statusCaches.get(providerId);
  if (!cache?.value) return undefined;
  return cache.expiresAt > cache.now()
    ? cache.value
    : { ...cache.value, stale: true };
}

export interface CliCommandResult {
  stdout: string;
  stderr: string;
}

type RunningChild = ChildProcessByStdio<null, Readable, Readable>;
type RunningProcess = RunningChild | pty.IPty;

class CliConnectorCommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode?: number | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CliConnectorCommandError';
  }
}

class CliConnectorTimeoutError extends CliConnectorCommandError {
  constructor(message: string, stdout: string, stderr: string) {
    super(message, stdout, stderr);
    this.name = 'CliConnectorTimeoutError';
  }
}

function cleanEnvironment(
  source: NodeJS.ProcessEnv,
  descriptor: CliConnectorDescriptor,
): NodeJS.ProcessEnv {
  const env = { ...source, ...descriptor.env.add };
  for (const key of descriptor.env.remove) delete env[key];
  return env;
}

function ptyEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function appendOutput(current: string, chunk: string | Buffer): string {
  const next = current + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
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

function valueAtPath(root: unknown, valuePath: readonly string[]): unknown {
  let current = root;
  for (const key of valuePath) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function optionalString(root: unknown, valuePath: readonly string[] | undefined): string | undefined {
  if (!valuePath) return undefined;
  const value = valueAtPath(root, valuePath);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function commandErrorCode(error: unknown): string | undefined {
  if (!(error instanceof CliConnectorCommandError)) return undefined;
  const raw = `${error.stdout}\n${error.stderr}`;
  const jsonCode = raw.match(/"(?:code|error_code)"\s*:\s*"?([\w-]+)"?/iu)?.[1];
  return jsonCode ?? raw.match(/(?:code|error_code)[=:\s]+([\w-]+)/iu)?.[1];
}

function matchesErrorMapping(error: unknown, mapping: CliErrorMapping): boolean {
  if (!(error instanceof CliConnectorCommandError)) return false;
  const code = commandErrorCode(error);
  const codeMatches = mapping.codes === '*'
    ? Boolean(code)
    : Boolean(code && mapping.codes?.includes(code));
  const outputMatches = mapping.outputPattern?.test(`${error.stdout}\n${error.stderr}`) ?? false;
  return codeMatches || outputMatches;
}

function isMissingConfiguration(error: unknown, descriptor: CliConnectorDescriptor): boolean {
  if (!(error instanceof CliConnectorCommandError)) return false;
  const raw = `${error.message}\n${error.stdout}\n${error.stderr}`;
  const causeCode = error.cause && typeof error.cause === 'object' && 'code' in error.cause
    ? String(error.cause.code)
    : '';
  return causeCode === 'ENOENT' || Boolean(descriptor.missingConfigurationPattern?.test(raw));
}

function waitForChild(
  child: RunningChild,
  commandLabel: string,
  timeoutMs: number,
  onOutput?: (combinedOutput: string, child: RunningChild) => void,
): Promise<CliCommandResult> {
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
      finish(() => reject(new CliConnectorTimeoutError(
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
      finish(() => reject(new CliConnectorCommandError(
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
      finish(() => reject(new CliConnectorCommandError(
        `${commandLabel} failed with exit code ${code ?? 'unknown'}`,
        stdout,
        stderr,
        code,
      )));
    });
  });
}

function cancelledError(): Error & { code: string } {
  const error = new Error('OAuth flow cancelled') as Error & { code: string };
  error.code = 'CANCELLED';
  return error;
}

export function createCliConnector(
  descriptor: CliConnectorDescriptor,
  options: CliConnectorOptions = {},
) {
  const logger = createLogger(descriptor.loggerName);
  const dataDir = options.dataDir ?? getUserDataPath();
  const installPrefix = path.join(dataDir, descriptor.installDirectory);
  const packageDir = path.join(installPrefix, 'node_modules', ...descriptor.packagePath);
  const packageJsonPath = path.join(packageDir, 'package.json');
  const binaryPath = path.join(packageDir, ...descriptor.binaryPath);
  const env = cleanEnvironment(options.env ?? process.env, descriptor);
  const timeoutMs = options.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
  const statusTimeoutMs = options.statusTimeoutMs ?? STATUS_TIMEOUT_MS;
  const statusCacheTtlMs = options.statusCacheTtlMs ?? STATUS_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const npmExecutable = options.npmExecutable ?? 'npm';
  let activeConnectProcess: RunningProcess | undefined;
  let connectCancelled = false;
  const useSharedStatusCache = options.dataDir === undefined
    && options.env === undefined
    && options.npmExecutable === undefined
    && options.timeoutMs === undefined
    && options.statusCacheTtlMs === undefined
    && options.statusTimeoutMs === undefined
    && options.now === undefined;
  const sharedStatusCache = useSharedStatusCache ? statusCaches.get(descriptor.id) : undefined;
  const statusCache: CliStatusCache = sharedStatusCache ?? {
    expiresAt: 0,
    generation: 0,
    now,
  };
  statusCaches.set(descriptor.id, statusCache);

  const invalidateStatusCache = (): void => {
    statusCache.value = undefined;
    statusCache.expiresAt = 0;
    statusCache.generation += 1;
    statusCache.inFlight = undefined;
  };

  const commandArguments = (command: CliCommandDescriptor): string[] => [
    ...command.args,
    ...(command.profile === 'append' ? descriptor.profileArguments ?? [] : []),
  ];

  const run = (
    executable: string,
    args: string[],
    label: string,
    onOutput?: (combinedOutput: string, child: RunningChild) => void,
    trackConnect = false,
    commandTimeoutMs = timeoutMs,
  ): Promise<CliCommandResult> => {
    const child = spawn(executable, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (trackConnect) activeConnectProcess = child;
    return waitForChild(child, label, commandTimeoutMs, onOutput).finally(() => {
      if (activeConnectProcess === child) activeConnectProcess = undefined;
    });
  };

  const runDescriptorCommand = (
    command: CliCommandDescriptor,
    onOutput?: (combinedOutput: string, child: RunningChild) => void,
    trackConnect = false,
    commandTimeoutMs = timeoutMs,
  ) => run(binaryPath, commandArguments(command), command.label, onOutput, trackConnect, commandTimeoutMs);

  const installedVersion = async (): Promise<string | undefined> => {
    try {
      const pkg = parseRecord(await readFile(packageJsonPath, 'utf8'), `${descriptor.binaryName} package.json`);
      return optionalString(pkg, ['version']);
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

  const ensureInstalled = async (trackConnect = false): Promise<void> => {
    const expectedPackageVersion = descriptor.packageJsonVersion ?? descriptor.version;
    if (await installedVersion() === expectedPackageVersion && await hasExecutable()) return;
    await mkdir(installPrefix, { recursive: true });
    await run(
      npmExecutable,
      ['install', '--prefix', installPrefix, `${descriptor.npmPackage}@${descriptor.version}`],
      `install ${descriptor.binaryName}`,
      undefined,
      trackConnect,
    );
    const version = await installedVersion();
    if (version !== expectedPackageVersion || !(await hasExecutable())) {
      throw new Error(`${descriptor.binaryName} ${descriptor.version} installation could not be verified`);
    }
  };

  const readFreshStatus = async (): Promise<CliConnectorStatus> => {
    try {
      const result = await runDescriptorCommand(
        descriptor.status.command,
        undefined,
        false,
        statusTimeoutMs,
      );
      const combined = stripAnsi(`${result.stdout}\n${result.stderr}`);
      let parsed: Record<string, unknown> | undefined;
      let connected = false;
      if (descriptor.status.match.type === 'json-path') {
        parsed = parseRecord(result.stdout, descriptor.status.command.label);
        connected = valueAtPath(parsed, descriptor.status.match.path) === descriptor.status.match.equals;
      } else {
        connected = descriptor.status.match.pattern.test(combined);
      }
      const identity = parsed
        ? optionalString(parsed, descriptor.status.identityPath) ?? (connected
          ? descriptor.status.connectedIdentity
          : descriptor.status.disconnectedIdentity)
        : connected ? descriptor.status.connectedIdentity : descriptor.status.disconnectedIdentity;
      const userRoot = parsed && descriptor.status.user
        ? valueAtPath(parsed, descriptor.status.user.rootPath)
        : undefined;
      const openId = optionalString(userRoot, descriptor.status.user?.openIdPath);
      const name = optionalString(userRoot, descriptor.status.user?.namePath);
      const tenantName = optionalString(userRoot, descriptor.status.user?.tenantNamePath);
      return {
        connected,
        identity,
        ...(openId || name || tenantName ? {
          user: {
            ...(openId ? { openId } : {}),
            ...(name ? { name } : {}),
            ...(tenantName ? { tenantName } : {}),
          },
        } : {}),
      };
    } catch (error) {
      if (error instanceof CliConnectorTimeoutError) {
        return {
          ...(statusCache.value ?? {
            connected: false,
            identity: descriptor.status.disconnectedIdentity,
          }),
          stale: true,
        };
      }
      return { connected: false, identity: descriptor.status.disconnectedIdentity };
    }
  };

  const status = (forceRefresh = false): Promise<CliConnectorStatus> => {
    if (!forceRefresh && statusCache.value && statusCache.expiresAt > now()) {
      return Promise.resolve(statusCache.value);
    }
    if (statusCache.inFlight) return statusCache.inFlight;

    const generation = statusCache.generation;
    const refresh = readFreshStatus().then((nextStatus) => {
      if (statusCache.generation === generation) {
        statusCache.value = nextStatus;
        statusCache.expiresAt = now() + statusCacheTtlMs;
      }
      return nextStatus;
    }).finally(() => {
      if (statusCache.inFlight === refresh) statusCache.inFlight = undefined;
    });
    statusCache.inFlight = refresh;
    return refresh;
  };

  const runPtyAuthStep = async (
    step: CliPtyUrlAuthStep,
    openExternal: (url: string) => void | Promise<void>,
  ): Promise<{ output: string; openedUrl?: string }> => {
    const commandArgs = commandArguments(step.command);
    const ptyExecutable = binaryPath.endsWith('.js') ? process.execPath : binaryPath;
    const args = binaryPath.endsWith('.js') ? [binaryPath, ...commandArgs] : commandArgs;
    let child: pty.IPty;
    try {
      child = pty.spawn(ptyExecutable, args, {
        name: 'xterm-color',
        cols: 100,
        rows: 30,
        cwd: installPrefix,
        env: ptyEnvironment(env),
      });
    } catch (error) {
      throw new CliConnectorCommandError(
        `${step.command.label} could not start`,
        '',
        '',
        undefined,
        { cause: error },
      );
    }
    activeConnectProcess = child;

    return new Promise((resolve, reject) => {
      let output = '';
      let openedUrl: string | undefined;
      let openError: unknown;
      let settled = false;
      let openPromise: Promise<void> | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (activeConnectProcess === child) activeConnectProcess = undefined;
        callback();
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(() => reject(new CliConnectorCommandError(
          `${step.command.label} timed out after ${timeoutMs}ms`,
          output,
          '',
        )));
      }, timeoutMs);
      timer.unref?.();

      child.onData((chunk) => {
        output = appendOutput(output, chunk);
        if (openedUrl) return;
        const matched = stripAnsi(output).match(step.urlPattern)?.[0];
        if (!matched) return;
        openedUrl = matched;
        openPromise = Promise.resolve()
          .then(() => openExternal(matched))
          .catch((error: unknown) => {
            openError = error;
            child.kill('SIGTERM');
          });
      });
      child.onExit(({ exitCode }) => {
        void Promise.resolve(openPromise).then(() => {
          if (openError) {
            finish(() => reject(new Error(step.openUrlErrorMessage, { cause: openError })));
            return;
          }
          if (exitCode === 0) {
            finish(() => resolve({ output, openedUrl }));
            return;
          }
          finish(() => reject(new CliConnectorCommandError(
            `${step.command.label} failed with exit code ${exitCode}`,
            output,
            '',
            exitCode,
          )));
        });
      });
    });
  };

  const pollForConnectedStatus = async (deadlineMs: number, intervalMs: number): Promise<boolean> => {
    while (Date.now() < deadlineMs) {
      if ((await status(true)).connected) return true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadlineMs - Date.now())));
        timer.unref?.();
      });
      if (connectCancelled) throw cancelledError();
    }
    return false;
  };

  const translateConnectionError = (error: unknown): Error => {
    const mapping = descriptor.errorMappings.find((candidate) => matchesErrorMapping(error, candidate));
    if (!mapping) return error instanceof Error ? error : new Error(String(error));
    if (mapping.logMessage) {
      logger.error(mapping.logMessage, { errorCode: commandErrorCode(error) ?? 'unknown' });
    }
    return new Error(mapping.message, { cause: error });
  };

  const connect = async (
    openExternal: (url: string) => void | Promise<void>,
    onStep?: (step: 1 | 2) => void,
  ): Promise<void> => {
    invalidateStatusCache();
    connectCancelled = false;
    const deadlineMs = Date.now() + timeoutMs;
    const assertNotCancelled = () => {
      if (connectCancelled) throw cancelledError();
    };
    try {
      await ensureInstalled(true);
      assertNotCancelled();
      for (const step of descriptor.authSteps) {
        if (step.kind === 'url' && step.skipIf) {
          try {
            await runDescriptorCommand(step.skipIf, undefined, true);
            continue;
          } catch {
            assertNotCancelled();
          }
        }

        onStep?.(step.step);
        if (step.kind === 'url') {
          let openedUrl: string | undefined;
          let openPromise: Promise<void> | undefined;
          let openError: unknown;
          let result: CliCommandResult;
          try {
            result = await runDescriptorCommand(
              step.command,
              (output, child) => {
                if (openedUrl) return;
                const matched = output.match(step.urlPattern)?.[0];
                if (!matched) return;
                openedUrl = matched;
                openPromise = Promise.resolve()
                  .then(() => openExternal(matched))
                  .catch((error: unknown) => {
                    openError = error;
                    child.kill('SIGTERM');
                  });
              },
              true,
            );
          } catch (error) {
            await openPromise;
            if (openError) throw new Error(step.openUrlErrorMessage, { cause: error });
            throw error;
          }
          const matched = openedUrl ?? stripAnsi(result.stdout).match(step.urlPattern)?.[0];
          if (!matched) throw new Error(step.missingUrlMessage);
          if (!openPromise) openPromise = Promise.resolve().then(() => openExternal(matched));
          await openPromise;
          if (openError) throw new Error(step.openUrlErrorMessage, { cause: openError });
          continue;
        }

        if (step.kind === 'device-code') {
          const login = await runDescriptorCommand(step.command, undefined, true);
          const payload = parseRecord(login.stdout, step.command.label);
          const deviceCode = optionalString(payload, [step.deviceCodeField]);
          const verificationUrl = optionalString(payload, [step.verificationUrlField]);
          if (!deviceCode || !verificationUrl) throw new Error(step.missingDeviceCodeMessage);
          await openExternal(verificationUrl);
          assertNotCancelled();
          const followUpArgs = step.followUp.args.map((arg) => arg === step.deviceCodePlaceholder
            ? deviceCode
            : arg);
          await runDescriptorCommand({ ...step.followUp, args: followUpArgs }, undefined, true);
          continue;
        }

        let ptyError: unknown;
        let openedUrl: string | undefined;
        try {
          const ptyResult = await runPtyAuthStep(step, openExternal);
          openedUrl = ptyResult.openedUrl;
          if (!openedUrl) throw new Error(step.missingUrlMessage);
        } catch (error) {
          ptyError = error;
          if (error instanceof CliConnectorCommandError) {
            openedUrl = stripAnsi(error.stdout).match(step.urlPattern)?.[0];
          }
          if (!openedUrl) throw error;
        }
        assertNotCancelled();
        if ((await status(true)).connected) continue;
        if (step.pollStatusAfterExit && await pollForConnectedStatus(deadlineMs, step.pollIntervalMs)) continue;
        if (ptyError) throw ptyError;
        throw new Error(`${descriptor.binaryName} authorization did not produce a connected status`);
      }
    } catch (error) {
      if (connectCancelled) throw cancelledError();
      throw translateConnectionError(error);
    } finally {
      activeConnectProcess = undefined;
      invalidateStatusCache();
    }
  };

  const cancelConnect = (): void => {
    connectCancelled = true;
    activeConnectProcess?.kill('SIGTERM');
  };

  const disconnect = async (): Promise<void> => {
    invalidateStatusCache();
    cancelConnect();
    try {
      await runDescriptorCommand(descriptor.logout);
    } catch (error) {
      if (isMissingConfiguration(error, descriptor)) return;
      throw error;
    } finally {
      invalidateStatusCache();
    }
  };

  const execute = async (args: string[], label: string): Promise<CliCommandResult> => {
    await ensureInstalled();
    return run(binaryPath, args, label);
  };

  return { ensureInstalled, status, connect, cancelConnect, disconnect, execute };
}
