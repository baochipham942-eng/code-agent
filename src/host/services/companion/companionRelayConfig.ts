import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import {
  companionRelayConfigSchema,
  resolveCompanionRelayConfig,
  type CompanionRelayResolved,
} from '../../../shared/contract/companionRelay';
import { loadKeytar } from '../core/keytarAdapter';

export interface CompanionRelayLogger {
  warn(message: string): void;
  info?(message: string): void;
}

export type CompanionRelayKeytarLoader = () => {
  getPassword(service: string, account: string): Promise<string | null>;
} | null;

export function errorHead(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0] ?? 'unknown';
}

function zodIssuePaths(error: { issues: Array<{ path: PropertyKey[]; keys?: string[] }> }): string {
  return [...new Set(error.issues.flatMap(issue => {
    if (issue.keys?.length) return issue.keys;
    return [issue.path.length === 0 ? 'root' : issue.path.map(String).join('.')];
  }))].join(', ');
}

function readCaPem(caFile: string, dataDirectory: string, logger?: CompanionRelayLogger): string | null {
  const caPath = resolve(dataDirectory, caFile);
  let pem: string;
  try {
    pem = readFileSync(caPath, 'utf8');
  } catch {
    logger?.warn(`Companion relay caFile unreadable: ${caPath}`);
    return null;
  }
  if (pem.length > L.relayCaPemMaxBytes || !pem.includes('BEGIN CERTIFICATE')) {
    logger?.warn(`Companion relay caFile invalid: ${caPath}`);
    return null;
  }
  return pem;
}

export function loadCompanionRelayConfig(
  dataDirectory: string,
  logger?: CompanionRelayLogger,
): CompanionRelayResolved | null {
  const configPath = resolve(dataDirectory, L.relayConfigFile);
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    logger?.warn(`Companion relay config file missing: ${configPath}`);
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    logger?.warn(`Companion relay config JSON parse failed: ${configPath}`);
    return null;
  }
  const parsed = companionRelayConfigSchema.safeParse(raw);
  if (!parsed.success) {
    logger?.warn(`Companion relay config schema invalid: ${zodIssuePaths(parsed.error)}`);
    return null;
  }
  if (parsed.data.enabled !== true) {
    logger?.warn('Companion relay config enabled is not true');
    return null;
  }
  if (!parsed.data.url) {
    logger?.warn('Companion relay config missing url');
    return null;
  }
  if (!parsed.data.credentialRef) {
    logger?.warn('Companion relay config missing credentialRef');
    return null;
  }
  let resolved: CompanionRelayResolved | null;
  try {
    resolved = resolveCompanionRelayConfig(raw);
  } catch (error) {
    logger?.warn(`Companion relay config url invalid: ${errorHead(error)}`);
    return null;
  }
  if (!resolved) {
    logger?.warn('Companion relay config schema invalid: root');
    return null;
  }
  if (!parsed.data.caFile) return resolved;
  const caPem = readCaPem(parsed.data.caFile, dataDirectory, logger);
  if (!caPem) return null;
  return { ...resolved, caPem };
}

export async function loadCompanionRelayCredential(
  credentialRef: string,
  opts?: {
    logger?: CompanionRelayLogger;
    loadKeytar?: CompanionRelayKeytarLoader;
  },
): Promise<string | null> {
  const keytar = (opts?.loadKeytar ?? loadKeytar)();
  if (!keytar) {
    opts?.logger?.warn('Companion relay keytar unavailable');
    return null;
  }
  try {
    const value = await keytar.getPassword(L.relayCredentialService, credentialRef);
    if (!value) {
      opts?.logger?.warn('Companion relay credential missing from keychain');
      return null;
    }
    if (value.length < L.relayAuthLength) {
      opts?.logger?.warn(`Companion relay credential too short: length=${value.length}`);
      return null;
    }
    return value;
  } catch (error) {
    opts?.logger?.warn(`Companion relay keytar error: ${errorHead(error)}`);
    return null;
  }
}
