#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  assertNoSensitiveDesktopShellDiagnostics,
  classifyDesktopShellDiagnostics,
  desktopShellDiagnosticsFailureMessage,
  extractDesktopShellDiagnostics,
} from './desktop-shell-diagnostics.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const BOOT_FILE = 'desktop-shell-boot-latest.json';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readArg(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function randomPort() {
  return 19000 + Math.floor(Math.random() * 20000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readPackageProductName() {
  try {
    return JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).productName ?? 'Agent Neo';
  } catch {
    return 'Agent Neo';
  }
}

function defaultAppPath() {
  const productName = readPackageProductName();
  const candidates = [
    path.resolve('src-tauri', 'target', 'release', 'bundle', 'macos', `${productName}.app`),
    path.resolve('src-tauri', 'target', 'release', 'bundle', 'macos', 'Agent Neo.app'),
    path.resolve('src-tauri', 'target', 'release', 'bundle', 'macos', 'Agent Neo Dev.app'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function findMacosExecutable(appPath) {
  const macosDir = path.join(appPath, 'Contents', 'MacOS');
  const entries = fs.readdirSync(macosDir)
    .map((entry) => path.join(macosDir, entry))
    .filter((entry) => {
      try {
        const stat = fs.statSync(entry);
        return stat.isFile() && (stat.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    });
  if (entries.length === 0) {
    throw new Error(`No executable found in ${macosDir}`);
  }
  return entries[0];
}

function readBundleIdentifier(appPath) {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', infoPlist], {
      encoding: 'utf8',
    }).trim();
  } catch {
    const text = fs.readFileSync(infoPlist, 'utf8');
    return text.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? 'com.linchen.code-agent';
  }
}

function defaultTauriAppDataDir(appPath) {
  return path.join(os.homedir(), 'Library', 'Application Support', readBundleIdentifier(appPath));
}

function parseGeneratedAtMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isFreshBootForSmoke(boot, port, startedAtMs) {
  if (!isRecord(boot)) return false;
  if (Number(boot.webPort) !== Number(port)) return false;
  const generatedAtMs = parseGeneratedAtMillis(boot.generatedAt);
  if (generatedAtMs !== undefined && generatedAtMs < startedAtMs - 5000) return false;
  return true;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text.trim() ? JSON.parse(text) : null;
    } catch {
      body = { parseError: true, textSample: text.slice(0, 200) };
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeHealthEvidence(health) {
  if (!isRecord(health)) return null;
  return {
    status: health.status,
    mode: health.mode,
    timestamp: health.timestamp,
    handlers: health.handlers,
    pid: health.pid,
    serverRoot: health.serverRoot,
    persistence: health.persistence,
    rendererServe: health.rendererServe,
    hasTauriBootToken: typeof health.tauriBootToken === 'string' && health.tauriBootToken.length > 0,
  };
}

function sanitizeBootEvidence(boot) {
  if (!isRecord(boot)) return null;
  return {
    schemaVersion: boot.schemaVersion,
    generatedAt: boot.generatedAt,
    appVersion: boot.appVersion,
    bundleId: boot.bundleId,
    pid: boot.pid,
    webPort: boot.webPort,
    stage: boot.stage,
    healthUrl: boot.healthUrl,
    bootId: boot.bootId,
    webServerPid: boot.webServerPid,
    serverRoot: boot.serverRoot,
    scriptPath: boot.scriptPath,
    nodeBinary: boot.nodeBinary,
    healthMatchedBootToken: boot.healthMatchedBootToken,
    diagnosticFile: boot.diagnosticFile,
    resources: Array.isArray(boot.resources) ? boot.resources : undefined,
    issues: Array.isArray(boot.issues) ? boot.issues : undefined,
  };
}

function pushFailure(failures, code, message, evidence = {}) {
  failures.push({ code, message, evidence });
}

function pushWarning(warnings, code, message, evidence = {}) {
  warnings.push({ code, message, evidence });
}

function readDevToken(dataDir) {
  try {
    const token = fs.readFileSync(path.join(dataDir, '.dev-token'), 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function readDomainDiagnostics(baseUrl, dataDir) {
  const token = readDevToken(dataDir);
  if (!token) return { response: null, error: 'auth token file not ready' };
  try {
    const response = await fetchJson(`${baseUrl}/api/domain/diagnostics/desktopShell`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { payload: {}, requestId: 'desktop-shell-packaged-smoke' },
      timeoutMs: 2500,
    });
    return { response: response.body, status: response.status };
  } catch (error) {
    return { response: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function verifyPackagedDesktopShellEvidence(evidence) {
  const boot = isRecord(evidence?.boot) ? evidence.boot : null;
  const staleBoot = isRecord(evidence?.staleBoot) ? evidence.staleBoot : null;
  const health = isRecord(evidence?.health) ? evidence.health : null;
  const ipcResponse = isRecord(evidence?.desktopShellResponse) ? evidence.desktopShellResponse : null;
  const diagnostics = extractDesktopShellDiagnostics(ipcResponse) ?? extractDesktopShellDiagnostics(evidence?.diagnostics);
  const classification = classifyDesktopShellDiagnostics(diagnostics);
  const failures = [];
  const warnings = [];
  const bootFile = evidence?.bootFile;
  const healthUrl = evidence?.healthUrl;
  const diagnosticsEndpoint = evidence?.diagnosticsEndpoint;

  if (!boot) {
    pushFailure(failures, 'desktop_shell_boot_json_missing', 'desktop-shell-boot-latest.json was not readable.', { bootFile });
    if (staleBoot) {
      pushWarning(warnings, 'desktop_shell_boot_json_stale', 'A boot diagnostics file exists but does not match this smoke run.', {
        bootFile,
        staleBoot: {
          webPort: staleBoot.webPort,
          stage: staleBoot.stage,
          generatedAt: staleBoot.generatedAt,
        },
      });
    }
  } else if (boot.schemaVersion !== 1) {
    pushFailure(failures, 'desktop_shell_boot_json_invalid', 'desktop-shell-boot-latest.json has an invalid schema version.', {
      schemaVersion: boot.schemaVersion,
      bootFile,
    });
  }

  if (!health) {
    pushFailure(failures, 'desktop_shell_health_missing', '/api/health did not return JSON.', { healthUrl });
  } else if (health.status !== 'ok') {
    pushFailure(failures, 'desktop_shell_health_not_ok', `/api/health status is ${health.status ?? 'missing'}.`, {
      healthUrl,
      status: health.status,
    });
  }

  if (!ipcResponse) {
    pushFailure(failures, 'desktop_shell_ipc_diagnostics_missing', 'diagnostics.desktopShell did not return a response.', {
      diagnosticsEndpoint,
    });
  } else if (ipcResponse.success !== true) {
    pushFailure(failures, 'desktop_shell_ipc_diagnostics_failed', 'diagnostics.desktopShell returned an IPC error.', {
      diagnosticsEndpoint,
      error: ipcResponse.error,
    });
  } else if (!diagnostics) {
    pushFailure(failures, 'desktop_shell_ipc_diagnostics_invalid', 'diagnostics.desktopShell did not contain DesktopShellDiagnostics.', {
      diagnosticsEndpoint,
    });
  }

  const bootPort = boot?.webPort;
  const diagnosticsPort = diagnostics?.app?.webPort;
  if (bootPort && diagnosticsPort && bootPort !== diagnosticsPort) {
    pushFailure(failures, 'desktop_shell_port_mismatch', 'boot diagnostics and desktopShell diagnostics disagree on webServer port.', {
      bootPort,
      diagnosticsPort,
    });
  }

  const bootWebPid = boot?.webServerPid;
  const healthPid = health?.pid;
  const diagnosticsWebPid = diagnostics?.webServer?.pid;
  const pidValues = [bootWebPid, healthPid, diagnosticsWebPid].filter((value) => typeof value === 'number');
  if (new Set(pidValues).size > 1) {
    pushFailure(failures, 'desktop_shell_pid_mismatch', 'boot diagnostics, /api/health, and desktopShell diagnostics disagree on webServer pid.', {
      bootWebPid,
      healthPid,
      diagnosticsWebPid,
    });
  }

  const healthRenderer = health?.rendererServe;
  const diagRenderer = diagnostics?.renderer;
  if (isRecord(healthRenderer) && isRecord(diagRenderer)) {
    if (healthRenderer.source !== diagRenderer.source || healthRenderer.reason !== diagRenderer.reason) {
      pushFailure(failures, 'desktop_shell_renderer_health_mismatch', '/api/health and desktopShell diagnostics disagree on renderer serve decision.', {
        healthRenderer: { source: healthRenderer.source, reason: healthRenderer.reason },
        desktopShellRenderer: { source: diagRenderer.source, reason: diagRenderer.reason },
      });
    }
  } else if (health && diagnostics) {
    pushWarning(warnings, 'desktop_shell_renderer_crosscheck_skipped', 'Renderer serve decision was not present in both health and desktopShell diagnostics.', {
      hasHealthRenderer: isRecord(healthRenderer),
      hasDesktopShellRenderer: isRecord(diagRenderer),
    });
  }

  if (classification.status === 'failed') {
    for (const issue of classification.issues.filter((entry) => entry.severity === 'error')) {
      pushFailure(failures, issue.code, issue.message, {
        action: issue.action,
        evidence: issue.evidence,
      });
    }
  }

  for (const issue of classification.issues.filter((entry) => entry.severity === 'warning')) {
    pushWarning(warnings, issue.code, issue.message, {
      action: issue.action,
      evidence: issue.evidence,
    });
  }

  const result = {
    ok: failures.length === 0,
    summary: {
      evidenceReady: Boolean(boot && health && diagnostics),
      bootFile,
      healthUrl,
      diagnosticsEndpoint,
      bootStage: boot?.stage ?? 'unknown',
      staleBootStage: staleBoot?.stage,
      port: diagnostics?.app?.webPort ?? boot?.webPort,
      webServerPid: bootWebPid ?? healthPid ?? diagnosticsWebPid,
      webHealth: health?.status ?? 'unknown',
      rendererSource: diagnostics?.renderer?.source ?? health?.rendererServe?.source,
      rendererReason: diagnostics?.renderer?.reason ?? health?.rendererServe?.reason,
      classificationStatus: classification.status,
    },
    failures,
    warnings,
    classification,
    evidence: {
      boot: sanitizeBootEvidence(boot),
      staleBoot: sanitizeBootEvidence(staleBoot),
      health: sanitizeHealthEvidence(health),
      desktopShell: diagnostics ?? null,
    },
  };
  assertNoSensitiveDesktopShellDiagnostics(result);
  return result;
}

async function collectEvidence({ dataDir, tauriDataDir, port, timeoutMs, startedAtMs }) {
  const baseUrl = `http://localhost:${port}`;
  const bootFile = path.join(tauriDataDir, 'logs', BOOT_FILE);
  const healthUrl = `${baseUrl}/api/health`;
  const diagnosticsEndpoint = `${baseUrl}/api/domain/diagnostics/desktopShell`;
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;

  while (Date.now() < deadline) {
    const bootCandidate = readJsonIfExists(bootFile);
    const boot = isFreshBootForSmoke(bootCandidate, port, startedAtMs) ? bootCandidate : null;
    const staleBoot = boot ? null : bootCandidate;
    let health = null;
    try {
      const response = await fetchJson(healthUrl, { timeoutMs: 1500 });
      if (response.ok && isRecord(response.body)) {
        health = response.body;
      }
    } catch {
      health = null;
    }
    const desktopShell = await readDomainDiagnostics(baseUrl, dataDir);
    lastResult = verifyPackagedDesktopShellEvidence({
      boot,
      staleBoot,
      health,
      desktopShellResponse: desktopShell.response,
      bootFile,
      healthUrl,
      diagnosticsEndpoint,
    });

    if (lastResult.summary.evidenceReady) {
      return lastResult;
    }
    await sleep(1000);
  }

  return lastResult ?? verifyPackagedDesktopShellEvidence({
    boot: null,
    staleBoot: readJsonIfExists(bootFile),
    health: null,
    desktopShellResponse: null,
    bootFile,
    healthUrl,
    diagnosticsEndpoint,
  });
}

function parseCliArgs(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) return { help: true };
  const dataDir = readArg(args, '--data-dir')
    ? path.resolve(readArg(args, '--data-dir'))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-desktop-smoke-'));
  const appPath = path.resolve(readArg(args, '--app') ?? defaultAppPath());
  return {
    appPath,
    dataDir,
    tauriDataDir: readArg(args, '--tauri-data-dir')
      ? path.resolve(readArg(args, '--tauri-data-dir'))
      : defaultTauriAppDataDir(appPath),
    port: Number(readArg(args, '--port') ?? randomPort()),
    timeoutMs: Number(readArg(args, '--timeout-ms') ?? DEFAULT_TIMEOUT_MS),
    skipLaunch: hasFlag(args, '--skip-launch'),
    keepRunning: hasFlag(args, '--keep-running'),
    json: hasFlag(args, '--json'),
    outFile: readArg(args, '--out') ? path.resolve(readArg(args, '--out')) : undefined,
  };
}

function usage() {
  return [
    'Usage: npm run desktop-shell:packaged-smoke -- --app "src-tauri/target/release/bundle/macos/Agent Neo.app" --json',
    '',
    'Options:',
    '  --app <path>        Packaged .app path. Defaults to the built release bundle.',
    '  --data-dir <dir>    Isolated CODE_AGENT_DATA_DIR. Defaults to a temp directory.',
    '  --tauri-data-dir <dir>',
    '                      Tauri app data dir for desktop-shell-boot-latest.json. Defaults from bundle id.',
    '  --port <n>          Isolated CODE_AGENT_WEB_PORT. Defaults to a random high port.',
    '  --timeout-ms <n>    Default: 120000',
    '  --skip-launch      Do not launch the app; only probe the given data-dir/port.',
    '  --keep-running     Leave the launched app process running.',
    '  --out <file>        Write the JSON smoke result to a file.',
    '  --json              Print JSON.',
  ].join('\n');
}

function launchApp(appPath, dataDir, port) {
  if (process.platform !== 'darwin') {
    throw new Error('desktop-shell packaged smoke can only launch a .app on macOS');
  }
  if (!fs.existsSync(appPath)) {
    throw new Error(`Packaged app not found: ${appPath}`);
  }
  const executable = findMacosExecutable(appPath);
  const child = spawn(executable, [], {
    cwd: path.join(appPath, 'Contents', 'Resources'),
    env: {
      ...process.env,
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_WEB_PORT: String(port),
      WEB_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    output = output.slice(-10_000);
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
    output = output.slice(-10_000);
  });
  child.on('error', (error) => {
    output += `\n[spawn error] ${error.message}`;
  });
  return { child, executable, getOutput: () => output };
}

function printHuman(result) {
  process.stdout.write(`[desktop-shell-smoke] ${result.ok ? 'ok' : 'failed'} ${JSON.stringify(result.summary)}\n`);
  for (const failure of result.failures) {
    process.stdout.write(`[desktop-shell-smoke][fail] [${failure.code}] ${failure.message}\n`);
  }
  for (const warning of result.warnings) {
    process.stdout.write(`[desktop-shell-smoke][warn] [${warning.code}] ${warning.message}\n`);
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let launched = null;
  try {
    fs.mkdirSync(path.join(options.dataDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(options.tauriDataDir, 'logs'), { recursive: true });
    const startedAtMs = Date.now();
    if (!options.skipLaunch) {
      launched = launchApp(options.appPath, options.dataDir, options.port);
    }

    const result = await collectEvidence({ ...options, startedAtMs });
    if (launched && launched.getOutput() && result.failures.length > 0) {
      result.launch = {
        executable: launched.executable,
        outputSample: launched.getOutput().slice(-4000),
      };
      assertNoSensitiveDesktopShellDiagnostics(result);
    }
    if (options.outFile) {
      fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
      fs.writeFileSync(options.outFile, `${JSON.stringify(result, null, 2)}\n`);
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printHuman(result);
    }
    if (!result.ok) {
      const message = desktopShellDiagnosticsFailureMessage(result.classification);
      if (message && !options.json) process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    const result = {
      ok: false,
      summary: {
        evidenceReady: false,
        bootFile: path.join(options.tauriDataDir, 'logs', BOOT_FILE),
        healthUrl: `http://localhost:${options.port}/api/health`,
        diagnosticsEndpoint: `http://localhost:${options.port}/api/domain/diagnostics/desktopShell`,
      },
      failures: [{
        code: 'desktop_shell_packaged_smoke_failed',
        message: error instanceof Error ? error.message : String(error),
      }],
      warnings: [],
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stderr.write(`[desktop-shell-smoke][FAIL] ${result.failures[0].message}\n`);
    }
    process.exitCode = 1;
  } finally {
    if (launched && !options.keepRunning) {
      try {
        launched.child.kill('SIGTERM');
      } catch {
        // best effort
      }
      setTimeout(() => {
        try {
          if (!launched.child.killed) launched.child.kill('SIGKILL');
        } catch {
          // best effort
        }
      }, 1000).unref();
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main();
}
