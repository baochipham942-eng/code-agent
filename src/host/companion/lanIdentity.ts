import { createHash } from 'node:crypto';
import type { KeyPair } from 'noise-handshake';
import { loadKeytar } from '../services/core/keytarAdapter';
import { createIdentity } from '../../shared/companion/noiseChannel';
import { fromHex, toHex } from '../../shared/companion/lanProtocol';

/** Installation/data-slot scoped; unavailable keychain means pairing stays unavailable. */
export async function loadLanIdentity(dataDirectory: string): Promise<KeyPair> {
  const keytar = loadKeytar();
  if (!keytar) throw new Error('COMPANION_SECURE_STORAGE_UNAVAILABLE');
  const service = 'dev.neo.companion.host.v1';
  const account = createHash('sha256').update(dataDirectory).digest('hex');
  const stored = await keytar.getPassword(service, account);
  if (stored) {
    const value = JSON.parse(stored) as { publicKey: string; secretKey: string };
    return { publicKey: fromHex(value.publicKey, 32), secretKey: fromHex(value.secretKey, 32) };
  }
  const identity = createIdentity();
  const encoded = JSON.stringify({ publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey) });
  try {
    await keytar.setPassword(service, account, encoded);
    if (await keytar.getPassword(service, account) !== encoded) throw new Error('COMPANION_SECURE_STORAGE_UNAVAILABLE');
    return identity;
  } catch (error) { identity.secretKey.fill(0); throw error; }
}
