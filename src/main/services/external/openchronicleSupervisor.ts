// ============================================================================
// OpenchronicleSupervisor — manage external OpenChronicle daemon lifecycle
//
// OC is a 7×24 background daemon (mac-ax-watcher + AX capture + LLM pipeline).
// We don't host it — we just toggle it from code-agent's settings UI.
//
// Toggle ON  → spawn `openchronicle start` + register MCP server
// Toggle OFF → unregister MCP server + spawn `openchronicle stop`
//
// Process lifecycle is independent of code-agent — closing the app does NOT
// stop OC. Only the toggle does.
// ============================================================================

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../infra/logger';
import { getUserConfigDir } from '../../config/configPaths';
import type {
  OpenchronicleSettings,
  OpenchronicleStatus,
  OpenchronicleProcessState,
} from '../../../shared/contract/openchronicle';
import { DEFAULT_OPENCHRONICLE_SETTINGS } from '../../../shared/contract/openchronicle';

const logger = createLogger('OpenchronicleSupervisor');

const SETTINGS_PATH = join(getUserConfigDir(), 'openchronicle-settings.json');
const SHIM_PATHS = [
  join(homedir(), '.local', 'bin', 'openchronicle'),
  '/opt/homebrew/bin/openchronicle',
  '/usr/local/bin/openchronicle',
];
const VENV_BIN = join(homedir(), '.openchronicle', 'venv', 'bin', 'openchronicle');
const MCP_HEALTH_URL = 'http://127.0.0.1:8742/mcp';
const MCP_SERVER_NAME = 'openchronicle';

let cachedShim: string | null = null;
let currentState: OpenchronicleProcessState = 'stopped';
let lastError = '';

// ---------------------------------------------------------------------------
// CLI shim resolution
// ---------------------------------------------------------------------------

async function resolveShim(): Promise<string | null> {
  if (cachedShim) return cachedShim;
  for (const candidate of [...SHIM_PATHS, VENV_BIN]) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      cachedShim = candidate;
      return candidate;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settings persistence (independent of AppSettings — keeps schema isolated)
// ---------------------------------------------------------------------------

export async function loadSettings(): Promise<OpenchronicleSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
    return { ...DEFAULT_OPENCHRONICLE_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_OPENCHRONICLE_SETTINGS };
  }
}

export async function saveSettings(settings: OpenchronicleSettings): Promise<void> {
  await fs.mkdir(getUserConfigDir(), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

function runShim(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(async (resolve) => {
    const shim = await resolveShim();
    if (!shim) {
      resolve({ code: -1, stdout: '', stderr: 'openchronicle CLI not found' });
      return;
    }
    const proc = spawn(shim, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    proc.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + e.message }));
  });
}

async function probeMcpHealthy(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(MCP_HEALTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json,text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'code-agent-probe', version: '1' } },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeMcpHealthy()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function startDaemon(): Promise<{ ok: boolean; error?: string }> {
  if (platform() !== 'darwin') {
    return { ok: false, error: 'OpenChronicle 仅支持 macOS' };
  }
  currentState = 'starting';
  lastError = '';
  const result = await runShim(['start']);
  if (result.code !== 0) {
    currentState = 'error';
    lastError = result.stderr.trim() || `exit ${result.code}`;
    logger.warn('start failed:', lastError);
    return { ok: false, error: lastError };
  }
  const healthy = await waitForHealthy();
  if (!healthy) {
    currentState = 'error';
    lastError = 'daemon started but MCP endpoint never became healthy';
    return { ok: false, error: lastError };
  }
  currentState = 'running';
  return { ok: true };
}

export async function stopDaemon(): Promise<{ ok: boolean; error?: string }> {
  currentState = 'stopping';
  const result = await runShim(['stop']);
  if (result.code !== 0 && !/not running|no daemon/i.test(result.stdout + result.stderr)) {
    currentState = 'error';
    lastError = result.stderr.trim() || `exit ${result.code}`;
    return { ok: false, error: lastError };
  }
  currentState = 'stopped';
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function getStatus(): Promise<OpenchronicleStatus> {
  const shim = await resolveShim();
  if (!shim) {
    return { state: 'stopped', mcpHealthy: false, lastError: 'OpenChronicle 未安装' };
  }
  const result = await runShim(['status']);
  const mcpHealthy = await probeMcpHealthy();

  // Parse minimal fields from `openchronicle status` text output
  let pid: number | undefined;
  let bufferFiles: number | undefined;
  let memoryEntries: number | undefined;

  const pidMatch = result.stdout.match(/running pid (\d+)/);
  if (pidMatch) pid = Number(pidMatch[1]);
  const bufMatch = result.stdout.match(/Buffer\s+(\d+) files/);
  if (bufMatch) bufferFiles = Number(bufMatch[1]);
  const memMatch = result.stdout.match(/(\d+) entries/);
  if (memMatch) memoryEntries = Number(memMatch[1]);

  const running = /Daemon\s+running/.test(result.stdout);
  if (running && currentState !== 'starting' && currentState !== 'stopping') {
    currentState = 'running';
  } else if (!running && currentState !== 'starting') {
    currentState = 'stopped';
  }

  return {
    state: currentState,
    pid,
    mcpEndpoint: MCP_HEALTH_URL,
    mcpHealthy,
    bufferFiles,
    memoryEntries,
    lastError: lastError || undefined,
  };
}

// ---------------------------------------------------------------------------
// Toggle (single source of truth: persisted settings.enabled)
// ---------------------------------------------------------------------------

export async function setEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const settings = await loadSettings();
  settings.enabled = enabled;
  await saveSettings(settings);

  if (enabled) {
    const start = await startDaemon();
    if (!start.ok) return start;
    await registerMcpServer();
    return { ok: true };
  } else {
    await unregisterMcpServer();
    return await stopDaemon();
  }
}

// ---------------------------------------------------------------------------
// MCP server registration (dynamic — only when toggle ON & daemon healthy)
// ---------------------------------------------------------------------------

async function registerMcpServer(): Promise<void> {
  // Lazy import to avoid circular deps with mcp module
  const { getMCPClient } = await import('../../mcp/mcpClient');
  const client = getMCPClient();
  if (!client) return;
  const existing = client.getServerStates?.() ?? [];
  if (Array.isArray(existing) && existing.some((s) => s.config?.name === MCP_SERVER_NAME)) {
    await client.setServerEnabled(MCP_SERVER_NAME, true);
    return;
  }
  client.addServer({
    name: MCP_SERVER_NAME,
    type: 'http-streamable',
    serverUrl: MCP_HEALTH_URL,
    enabled: true,
  });
}

async function unregisterMcpServer(): Promise<void> {
  const { getMCPClient } = await import('../../mcp/mcpClient');
  const client = getMCPClient();
  if (!client) return;
  try {
    await client.removeServer(MCP_SERVER_NAME);
  } catch (e) {
    logger.debug('removeServer no-op:', e);
  }
}

// ---------------------------------------------------------------------------
// Init — called on app start to reconcile state with persisted settings
// ---------------------------------------------------------------------------

export async function initOpenchronicle(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    logger.info('OpenChronicle toggle is OFF — daemon left untouched');
    return;
  }
  // Toggle was ON last time. Probe — if daemon is still running, just register MCP.
  // Otherwise, restart it.
  const healthy = await probeMcpHealthy();
  if (healthy) {
    logger.info('OpenChronicle daemon already running; registering MCP server');
    await registerMcpServer();
    currentState = 'running';
    return;
  }
  logger.info('OpenChronicle toggle is ON but daemon down; restarting');
  const start = await startDaemon();
  if (start.ok) await registerMcpServer();
}
