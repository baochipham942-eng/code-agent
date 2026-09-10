import { COMPANION_LIMITS as L } from '../constants/companion';

export interface LanInvitation {
  version: 1; endpoint: string; inviteId: string; psk: string; hostKey: string; expiresAt: number;
}
export interface LanBinding {
  version: 1; endpoint: string; hostKey: string; deviceId: string; scopeEpoch: number; scope: string[];
}
export const LAN_PROLOGUE = 'neo-companion/lan/v1';
export function toHex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function fromHex(value: unknown, bytes?: number): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value) || value.length > L.maxFrameBytes * 2 ||
      (bytes !== undefined && value.length !== bytes * 2)) throw new Error('COMPANION_INVALID_FRAME');
  return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}
export function isPrivateIPv4(host: string): boolean {
  const octets = host.split('.');
  if (octets.length !== 4 || octets.some(n => !/^(0|[1-9]\d{0,2})$/.test(n) || Number(n) > 255)) return false;
  const [a, b] = octets.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function validateLanEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !isPrivateIPv4(url.hostname) || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin !== endpoint) {
    throw new Error('COMPANION_INVALID_LAN_ENDPOINT');
  }
  return endpoint;
}
export function parseInvitation(raw: string, now = Date.now()): LanInvitation {
  if (raw.length > 2_048) throw new Error('COMPANION_INVALID_INVITATION');
  const v = JSON.parse(raw) as LanInvitation;
  if (v.version !== 1 || typeof v.endpoint !== 'string' || typeof v.inviteId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(v.inviteId) || !Number.isSafeInteger(v.expiresAt) ||
      v.expiresAt <= now || v.expiresAt > now + L.invitationTtlMs) throw new Error('COMPANION_INVALID_INVITATION');
  validateLanEndpoint(v.endpoint); fromHex(v.psk, 32); fromHex(v.hostKey, 32);
  return v;
}
