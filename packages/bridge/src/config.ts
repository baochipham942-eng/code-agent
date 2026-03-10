import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BridgeConfig } from './types';

const DEFAULT_PORT = 9527;
const DEFAULT_SHELL_TIMEOUT = 120000;

export function getBridgeHome(): string {
  return path.join(os.homedir(), '.code-agent-bridge');
}

export function getConfigPath(): string {
  return path.join(getBridgeHome(), 'config.json');
}

export function getTokenPath(): string {
  return path.join(getBridgeHome(), 'token');
}

export const defaultConfig = (cwd = process.cwd()): BridgeConfig => ({
  port: DEFAULT_PORT,
  workingDirectories: [path.resolve(cwd)],
  securityLevel: 'normal',
  commandWhitelist: ['ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'git', 'npm', 'pnpm', 'node'],
  commandBlacklist: ['sudo', 'rm', 'mkfs', 'dd'],
  autoConfirmL2: false,
  shellTimeout: DEFAULT_SHELL_TIMEOUT,
});

function normalizeConfig(input: Partial<BridgeConfig>, cwd = process.cwd()): BridgeConfig {
  const base = defaultConfig(cwd);
  const workingDirectories = (input.workingDirectories ?? base.workingDirectories)
    .map((item) => path.resolve(item))
    .filter((item, index, arr) => item && arr.indexOf(item) === index);

  return {
    port: typeof input.port === 'number' ? input.port : base.port,
    workingDirectories: workingDirectories.length > 0 ? workingDirectories : base.workingDirectories,
    securityLevel: input.securityLevel ?? base.securityLevel,
    commandWhitelist: [...new Set(input.commandWhitelist ?? base.commandWhitelist)],
    commandBlacklist: [...new Set(input.commandBlacklist ?? base.commandBlacklist)],
    autoConfirmL2: typeof input.autoConfirmL2 === 'boolean' ? input.autoConfirmL2 : base.autoConfirmL2,
    shellTimeout:
      typeof input.shellTimeout === 'number' && input.shellTimeout > 0
        ? input.shellTimeout
        : base.shellTimeout,
  };
}

export async function ensureBridgeHome(): Promise<void> {
  await fs.mkdir(getBridgeHome(), { recursive: true });
}

export async function loadConfig(configPath = getConfigPath(), cwd = process.cwd()): Promise<BridgeConfig> {
  await ensureBridgeHome();
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return normalizeConfig(JSON.parse(raw) as Partial<BridgeConfig>, cwd);
  } catch {
    const config = defaultConfig(cwd);
    await saveConfig(config, configPath);
    return config;
  }
}

export async function saveConfig(config: Partial<BridgeConfig>, configPath = getConfigPath()): Promise<BridgeConfig> {
  await ensureBridgeHome();
  const normalized = normalizeConfig(config);
  await fs.writeFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

export async function updateConfig(
  next: Partial<BridgeConfig>,
  configPath = getConfigPath(),
  cwd = process.cwd()
): Promise<BridgeConfig> {
  const current = await loadConfig(configPath, cwd);
  return saveConfig({ ...current, ...next }, configPath);
}

export async function ensureAuthToken(tokenPath = getTokenPath()): Promise<string> {
  await ensureBridgeHome();
  try {
    const token = (await fs.readFile(tokenPath, 'utf8')).trim();
    if (token) {
      return token;
    }
  } catch {
    // fall through
  }
  const token = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600, encoding: 'utf8' });
  return token;
}
