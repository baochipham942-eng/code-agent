#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLI_CONNECTOR_DESCRIPTORS } from '../src/shared/constants/cliConnectorDescriptors.ts';

const PROVIDER_ID = 'custom-tokenrhythm';
const MODEL_ID = 'deepseek-v4-flash';
const STATE_FILE = '.neo-verify-state.json';
const DEFAULT_SECRET_FILE = path.join(os.homedir(), '.ship', 'secrets', 'neo-dogfood.env');
const DEFAULT_SOURCE_DATA_DIR = path.join(os.homedir(), '.code-agent-dev');
const DEFAULT_SOURCE_CONFIG = path.join(DEFAULT_SOURCE_DATA_DIR, 'config.json');
const VERIFY_NATIVE_CONNECTOR_IDS = ['calendar', 'reminders'];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-slotless.mjs <ticket> [--reuse-dist]',
    '  node scripts/verify-slotless.mjs --stop <NEO_VERIFY_DATA_DIR>',
    '',
    'Starts the worktree webServer on an isolated port and signs in with the dogfood account.',
    'Native Calendar/Reminders verification requires a real macOS host with osascript access.',
  ].join('\n');
}

function fail(message) {
  throw new Error(message);
}

function sanitizeTicket(value) {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!sanitized) fail('ticket must contain at least one letter or digit');
  return sanitized.slice(0, 80);
}

function copyModelDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = [
    'label',
    'enabled',
    'capabilities',
    'maxTokens',
    'supportsTool',
    'supportsVision',
    'supportsStreaming',
  ];
  return Object.fromEntries(allowed.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

export function buildSlotlessConfig(source, tokenRhythmKey) {
  const sourceModels = source?.models;
  const sourceProvider = sourceModels?.providers?.[PROVIDER_ID];
  const sourceModel = sourceProvider?.models?.[MODEL_ID];
  if (!sourceProvider || typeof sourceProvider !== 'object' || Array.isArray(sourceProvider)) {
    fail(`source config is missing provider ${PROVIDER_ID}`);
  }
  if (!sourceModel || typeof sourceModel !== 'object' || Array.isArray(sourceModel)) {
    fail(`source config is missing model ${PROVIDER_ID}/${MODEL_ID}`);
  }

  const provider = {};
  for (const key of ['enabled', 'displayName', 'baseUrl', 'protocol', 'temperature', 'maxTokens']) {
    if (sourceProvider[key] !== undefined) provider[key] = sourceProvider[key];
  }
  provider.enabled = true;
  provider.apiKey = tokenRhythmKey;
  provider.model = MODEL_ID;
  provider.models = { [MODEL_ID]: copyModelDescriptor(sourceModel) };

  // ConfigService 会把未出现的内置 provider 与默认值合并，其中若干默认 enabled=true。
  // 显式关闭源配置里的其他 provider，避免临时实例把空壳 provider 呈现为可选项；只复制
  // enabled=false 这个否定标记，不复制模型、URL、key 或其他账号配置。
  const providers = Object.fromEntries(
    Object.keys(sourceModels.providers)
      .filter((providerId) => providerId !== PROVIDER_ID)
      .map((providerId) => [providerId, { enabled: false }]),
  );
  providers[PROVIDER_ID] = provider;

  const routeNames = Object.keys(sourceModels?.routing ?? {});
  const routing = Object.fromEntries(
    (routeNames.length > 0 ? routeNames : ['code', 'fast', 'chat'])
      .map((route) => [route, { provider: PROVIDER_ID, model: MODEL_ID }]),
  );

  const config = {
    models: {
      default: PROVIDER_ID,
      defaultProvider: PROVIDER_ID,
      providers,
      routing,
    },
    cloud: { enabled: false, warmupOnInit: false },
  };

  // 无槽真机验收默认覆盖原生日历与提醒。两者通过 osascript 访问系统 App，只能
  // 在已授予相应自动化权限的真实 macOS 主机上工作。连接器段的其他字段照常保留。
  config.connectors = {
    ...(source?.connectors && typeof source.connectors === 'object' && !Array.isArray(source.connectors)
      ? source.connectors
      : {}),
    enabledNative: [...VERIFY_NATIVE_CONNECTOR_IDS],
  };

  // MCP server 清单属于能力中心的运行配置；其他用户设置仍不进入一次性验证目录。
  // CLI 登录凭据不在 config.json，由各 CLI 自己从全局位置读取。
  if (source?.mcp !== undefined) {
    config.mcp = source.mcp;
  }

  return config;
}

export function linkCliConnectorInstallDirectories(
  sourceDataDir,
  targetDataDir,
  log = (message) => console.log(message),
) {
  const results = [];
  for (const descriptor of CLI_CONNECTOR_DESCRIPTORS) {
    const installDirectory = descriptor.installDirectory;
    if (
      !installDirectory
      || path.isAbsolute(installDirectory)
      || installDirectory !== path.basename(installDirectory)
      || installDirectory === '.'
      || installDirectory === '..'
    ) {
      fail(`invalid CLI connector installDirectory for ${descriptor.id}: ${installDirectory}`);
    }

    const source = path.join(sourceDataDir, installDirectory);
    const target = path.join(targetDataDir, installDirectory);
    if (!existsSync(source)) {
      log(`CLI_CONNECTOR_SKIPPED=${descriptor.id}: source install directory not found (${source})`);
      results.push({ id: descriptor.id, installDirectory, status: 'skipped', reason: 'not-found' });
      continue;
    }
    if (!statSync(source).isDirectory()) {
      log(`CLI_CONNECTOR_SKIPPED=${descriptor.id}: source install path is not a directory (${source})`);
      results.push({ id: descriptor.id, installDirectory, status: 'skipped', reason: 'not-directory' });
      continue;
    }

    symlinkSync(source, target, 'dir');
    log(`CLI_CONNECTOR_LINKED=${descriptor.id}: ${target} -> ${source}`);
    results.push({ id: descriptor.id, installDirectory, status: 'linked', source, target });
  }
  return results;
}

function stripInlineComment(value) {
  const commentIndex = value.search(/\s+#/);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}

function parseDoubleQuoted(value) {
  try {
    return JSON.parse(value);
  } catch {
    fail('dogfood credential file contains an invalid double-quoted value');
  }
}

export function parseDogfoodEnv(raw) {
  const values = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) fail('dogfood credential file contains an invalid line');
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (value.startsWith('"')) {
      if (!value.endsWith('"')) fail('dogfood credential file contains an unterminated double-quoted value');
      value = parseDoubleQuoted(value);
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) fail('dogfood credential file contains an unterminated single-quoted value');
      value = value.slice(1, -1);
    } else {
      value = stripInlineComment(value);
    }
    values[key] = value;
  }
  return values;
}

export function readDogfoodCredentials(secretFile = DEFAULT_SECRET_FILE) {
  if (!existsSync(secretFile)) {
    fail(`dogfood credential file is required: ${secretFile}`);
  }
  const stat = statSync(secretFile);
  if (!stat.isFile()) fail(`dogfood credential path is not a file: ${secretFile}`);
  if ((stat.mode & 0o777) !== 0o600) {
    fail(`dogfood credential file must have mode 600: ${secretFile}`);
  }
  const values = parseDogfoodEnv(readFileSync(secretFile, 'utf8'));
  const tokenRhythmKey = values.NEO_DOGFOOD_TR_KEY?.trim();
  if (!tokenRhythmKey) fail('缺 NEO_DOGFOOD_TR_KEY');
  if (!tokenRhythmKey.startsWith('sk_tr_')) {
    fail('NEO_DOGFOOD_TR_KEY must start with sk_tr_');
  }
  const email = values.NEO_DOGFOOD_EMAIL?.trim();
  const password = values.NEO_DOGFOOD_PASSWORD;
  if (!email || !password) {
    fail('dogfood credential file must define NEO_DOGFOOD_EMAIL and NEO_DOGFOOD_PASSWORD');
  }
  return { email, password, tokenRhythmKey };
}

export function maskTokenRhythmKey(value) {
  if (typeof value !== 'string' || !value.startsWith('sk_tr_') || value.length < 10) {
    fail('cannot mask invalid NEO_DOGFOOD_TR_KEY');
  }
  return `sk_tr_…${value.slice(-4)}`;
}

function writePrivateJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(filePath, 0o600);
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to reserve a local port'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function ensureDist(reuseDist) {
  const webServer = path.join(repoRoot, 'dist', 'web', 'webServer.cjs');
  const renderer = path.join(repoRoot, 'dist', 'renderer', 'index.html');
  if (!reuseDist) {
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) fail(`npm run build failed to start: ${result.error.message}`);
    if (result.status !== 0) fail(`npm run build failed with exit code ${result.status ?? 'unknown'}`);
  }
  if (!existsSync(webServer) || !existsSync(renderer)) {
    fail('dist/web/webServer.cjs or dist/renderer/index.html is missing; run without --reuse-dist');
  }
  return webServer;
}

async function waitForHealth(child, url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`webServer exited before healthcheck (exit ${child.exitCode})`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      if (response.ok && body.status === 'ok') return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`timed out waiting for webServer health: ${lastError}`);
}

async function readServerToken(dataDir, timeoutMs = 10_000) {
  const tokenFile = path.join(dataDir, '.dev-token');
  const repoTokenFile = path.join(repoRoot, '.dev-token');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of [tokenFile, repoTokenFile]) {
      if (!existsSync(candidate)) continue;
      const token = readFileSync(candidate, 'utf8').trim();
      if (token) return token;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('webServer auth token was not created');
}

async function invokeAuth(url, token, action, payload) {
  const response = await fetch(`${url}/api/domain/auth/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payload }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    fail(`auth ${action} failed with HTTP ${response.status}`);
  }
  return body.data;
}

async function signInDogfood(url, token, credentials) {
  const result = await invokeAuth(url, token, 'signInEmail', {
    email: credentials.email,
    password: credentials.password,
  });
  if (!result?.success) fail('dogfood account sign-in was rejected');
  const status = await invokeAuth(url, token, 'getStatus');
  if (!status?.isAuthenticated || status?.user?.email !== credentials.email) {
    fail('dogfood account did not reach authenticated state');
  }
}

async function assertConfiguredModel(url, token) {
  const response = await fetch(`${url}/api/domain/settings/get`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payload: null }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  const settings = body?.success ? body.data : null;
  const provider = settings?.models?.providers?.[PROVIDER_ID];
  const model = provider?.models?.[MODEL_ID];
  if (
    !response.ok
    || !provider
    || provider.enabled === false
    || provider.apiKeyConfigured !== true
    || !model
    || model.enabled === false
  ) {
    fail(`model self-check failed: ${PROVIDER_ID}/${MODEL_ID} is not configured`);
  }
}

async function assertConfiguredNativeConnectors(url, token) {
  if (process.platform !== 'darwin') {
    fail('native Calendar/Reminders verification requires a real macOS host');
  }

  for (const connectorId of VERIFY_NATIVE_CONNECTOR_IDS) {
    const response = await fetch(`${url}/api/domain/connector/probe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payload: { connectorId } }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);
    const status = body?.success && Array.isArray(body.data)
      ? body.data.find((item) => item?.id === connectorId)
      : null;
    if (!response.ok || !status?.connected || status.readiness !== 'ready') {
      fail(`native connector self-check failed: ${connectorId}`);
    }
  }
}

function signalRun(state, signal) {
  try {
    process.kill(-state.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function stopProcessGroup(state) {
  if (!isAlive(state.pid)) return;
  const command = execFileSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  if (!command.includes(state.marker) || !state.marker.startsWith('neo-verify-')) {
    fail(`refusing to stop pid ${state.pid}: process marker does not match state file`);
  }
  signalRun(state, 'SIGTERM');
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && isAlive(state.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isAlive(state.pid)) signalRun(state, 'SIGKILL');
}

function assertDisposableDataDir(dataDir) {
  const resolved = realpathSync(dataDir);
  const tempRoot = realpathSync(os.tmpdir());
  if (!resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith('neo-verify-')) {
    fail(`refusing to remove non-slotless data directory: ${resolved}`);
  }
  return resolved;
}

export async function stopRun(dataDirArg) {
  const dataDir = path.resolve(dataDirArg || process.env.NEO_VERIFY_DATA_DIR || '');
  if (!dataDirArg && !process.env.NEO_VERIFY_DATA_DIR) fail('--stop requires NEO_VERIFY_DATA_DIR');
  if (!existsSync(dataDir)) fail(`slotless data directory does not exist: ${dataDir}`);
  const disposableDir = assertDisposableDataDir(dataDir);
  const statePath = path.join(disposableDir, STATE_FILE);
  if (!existsSync(statePath)) fail(`slotless state file is missing: ${statePath}`);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (!Number.isInteger(state.pid) || typeof state.marker !== 'string') fail('slotless state file is invalid');
  await stopProcessGroup(state);
  rmSync(disposableDir, { recursive: true, force: false });
  console.log(`NEO_VERIFY_STOPPED=${disposableDir}`);
}

async function cleanupFailedStart(child, dataDir, marker) {
  if (child && child.pid) {
    try {
      await stopProcessGroup({ pid: child.pid, marker });
    } catch {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process may already be gone */ }
    }
  }
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
}

async function startRun(ticketArg, reuseDist) {
  const ticket = sanitizeTicket(ticketArg);
  const credentials = readDogfoodCredentials();
  const sourceConfig = JSON.parse(readFileSync(DEFAULT_SOURCE_CONFIG, 'utf8'));
  const config = buildSlotlessConfig(sourceConfig, credentials.tokenRhythmKey);
  const webServer = ensureDist(reuseDist);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), `neo-verify-${ticket}-`));
  chmodSync(dataDir, 0o700);
  writePrivateJson(path.join(dataDir, 'config.json'), config);
  linkCliConnectorInstallDirectories(DEFAULT_SOURCE_DATA_DIR, dataDir);

  const port = await reservePort();
  const url = `http://127.0.0.1:${port}`;
  const marker = path.basename(dataDir);
  const logPath = path.join(dataDir, 'webserver.log');
  const logFd = openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [webServer, `--neo-verify-run=${marker}`], {
      cwd: dataDir,
      detached: true,
      env: {
        ...process.env,
        AGENT_NEO_BUNDLED_RUNTIME_ROOT: repoRoot,
        CODE_AGENT_DATA_DIR: dataDir,
        CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
        CODE_AGENT_WORKING_DIR: repoRoot,
        WEB_HOST: '127.0.0.1',
        WEB_PORT: String(port),
      },
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }

  try {
    await waitForHealth(child, url);
    const token = await readServerToken(dataDir);
    await signInDogfood(url, token, credentials);
    await assertConfiguredModel(url, token);
    await assertConfiguredNativeConnectors(url, token);
    writePrivateJson(path.join(dataDir, STATE_FILE), {
      version: 1,
      ticket,
      marker,
      pid: child.pid,
      port,
      dataDir,
      repoRoot,
      startedAt: new Date().toISOString(),
    });
    child.unref();
    console.log(`NEO_VERIFY_KEY=${maskTokenRhythmKey(credentials.tokenRhythmKey)}`);
    console.log(`NEO_VERIFY_MODEL=${PROVIDER_ID}/${MODEL_ID}`);
    console.log(`NEO_VERIFY_NATIVE=${VERIFY_NATIVE_CONNECTOR_IDS.join(',')}`);
    console.log(`NEO_VERIFY_URL=${url}`);
    console.log(`NEO_VERIFY_DATA_DIR=${dataDir}`);
  } catch (error) {
    await cleanupFailedStart(child, dataDir, marker);
    throw error;
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }
  if (args[0] === '--stop') {
    await stopRun(args[1]);
    return;
  }
  const ticket = args.find((arg) => !arg.startsWith('--'));
  if (!ticket) fail(usage());
  const unknown = args.filter((arg) => arg !== ticket && arg !== '--reuse-dist');
  if (unknown.length > 0) fail(`unknown option: ${unknown[0]}\n${usage()}`);
  await startRun(ticket, args.includes('--reuse-dist'));
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(`verify-slotless: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
