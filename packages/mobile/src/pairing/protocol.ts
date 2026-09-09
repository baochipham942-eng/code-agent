import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign, verify, createPublicKey, createPrivateKey } from 'node:crypto';

export type Identity = { id: string; publicKey: string; privateKey: string };
export type Invitation = { version: 1; id: string; issuerId: string; secret: string; expiresAt: number; used: boolean };
export type DeviceRecord = { id: string; publicKey: string; pairedAt: number; revokedAt?: number };
export type PairingErrorCode = 'INVITE_EXPIRED' | 'INVITE_REPLAYED' | 'IDENTITY_MISMATCH' | 'PROTOCOL_DOWNGRADE' | 'FRAME_TAMPERED' | 'FRAME_REPLAYED' | 'REVOKED';
export class PairingError extends Error { constructor(public readonly code: PairingErrorCode) { super(code); } }

export interface SecretStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete?(key: string): Promise<void>; }

export function createIdentity(id = randomBytes(16).toString('hex')): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { id, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}

export function issueInvitation(issuer: Identity, ttlMs = 120_000, now = Date.now()): Invitation {
  return { version: 1, id: randomBytes(16).toString('hex'), issuerId: issuer.id, secret: randomBytes(32).toString('base64url'), expiresAt: now + ttlMs, used: false };
}

export function encodeInvitation(invite: Invitation): string { return Buffer.from(JSON.stringify(invite)).toString('base64url'); }
export function decodeInvitation(encoded: string): Invitation { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Invitation; }

export function acceptInvitation(invite: Invitation, host: Identity, phone: Identity, now = Date.now()): { host: DeviceRecord; phone: DeviceRecord; sessionKey: Buffer } {
  if (invite.version !== 1) throw new PairingError('PROTOCOL_DOWNGRADE');
  if (invite.used || now >= invite.expiresAt) throw new PairingError(invite.used ? 'INVITE_REPLAYED' : 'INVITE_EXPIRED');
  if (invite.issuerId !== host.id) throw new PairingError('IDENTITY_MISMATCH');
  const sessionKey = createHash('sha256').update(`neo-pair-v1\0${invite.secret}\0${host.id}\0${phone.id}`).digest();
  invite.used = true;
  return { host: { id: host.id, publicKey: host.publicKey, pairedAt: now }, phone: { id: phone.id, publicKey: phone.publicKey, pairedAt: now }, sessionKey };
}

export function signHandshake(identity: Identity, payload: string): string {
  return sign(null, Buffer.from(payload), createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), type: 'pkcs8', format: 'der' })).toString('base64');
}
export function verifyHandshake(identity: Pick<Identity, 'publicKey'>, payload: string, signature: string): boolean {
  return verify(null, Buffer.from(payload), createPublicKey({ key: Buffer.from(identity.publicKey, 'base64'), type: 'spki', format: 'der' }), Buffer.from(signature, 'base64'));
}

export type SecureFrame = { version: 1; senderId: string; seq: number; nonce: string; ciphertext: string; tag: string };
export function encryptFrame(key: Buffer, senderId: string, seq: number, plaintext: string): SecureFrame {
  const nonce = randomBytes(12); const aad = Buffer.from(`neo-pair-v1\0${senderId}\0${seq}`); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { version: 1, senderId, seq, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function decryptFrame(key: Buffer, frame: SecureFrame, expectedSenderId: string, lastSeq: number): { plaintext: string; seq: number } {
  if (frame.version !== 1) throw new PairingError('PROTOCOL_DOWNGRADE');
  if (frame.senderId !== expectedSenderId) throw new PairingError('IDENTITY_MISMATCH');
  if (!Number.isSafeInteger(frame.seq) || frame.seq <= lastSeq) throw new PairingError('FRAME_REPLAYED');
  try {
    const aad = Buffer.from(`neo-pair-v1\0${frame.senderId}\0${frame.seq}`); const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(frame.nonce, 'base64')); decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(frame.tag, 'base64'));
    return { plaintext: Buffer.concat([decipher.update(Buffer.from(frame.ciphertext, 'base64')), decipher.final()]).toString('utf8'), seq: frame.seq };
  } catch { throw new PairingError('FRAME_TAMPERED'); }
}

export class PairingRegistry {
  private devices = new Map<string, DeviceRecord>();
  pair(records: { host: DeviceRecord; phone: DeviceRecord }): void { this.devices.set(records.phone.id, records.phone); }
  revoke(id: string, now = Date.now()): void { const d = this.devices.get(id); if (d) d.revokedAt = now; }
  isRevoked(id: string): boolean { return this.devices.get(id)?.revokedAt !== undefined; }
  assertUsable(id: string): void { if (this.isRevoked(id)) throw new PairingError('REVOKED'); }
  list(): DeviceRecord[] { return [...this.devices.values()].map(d => ({ ...d })); }
}

export async function saveIdentity(store: SecretStore, identity: Identity): Promise<void> { await store.set('mobile.pairing.identity.v1', JSON.stringify(identity)); }
export async function loadIdentity(store: SecretStore): Promise<Identity | null> { const raw = await store.get('mobile.pairing.identity.v1'); return raw ? JSON.parse(raw) as Identity : null; }
