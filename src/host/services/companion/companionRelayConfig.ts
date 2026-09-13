import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import {
  resolveCompanionRelayConfig,
  type CompanionRelayResolved,
} from '../../../shared/contract/companionRelay';
import { loadKeytar } from '../core/keytarAdapter';

export function loadCompanionRelayConfig(dataDirectory: string): CompanionRelayResolved | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDirectory, L.relayConfigFile), 'utf8')) as unknown;
    return resolveCompanionRelayConfig(raw);
  } catch {
    return null;
  }
}

export async function loadCompanionRelayCredential(credentialRef: string): Promise<string | null> {
  const keytar = loadKeytar();
  if (!keytar) return null;
  try {
    const value = await keytar.getPassword(L.relayCredentialService, credentialRef);
    return value && value.length >= L.relayAuthLength ? value : null;
  } catch {
    return null;
  }
}
