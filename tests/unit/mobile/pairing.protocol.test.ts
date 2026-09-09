import { describe, expect, it } from 'vitest';
import { acceptInvitation, createIdentity, decryptFrame, encryptFrame, issueInvitation, PairingError, PairingRegistry, signHandshake, verifyHandshake } from './protocol';

describe('mobile pairing protocol', () => {
  it('pairs once and rejects expiry/replay/identity mismatch', () => {
    const host = createIdentity('host'); const phone = createIdentity('phone');
    const invite = issueInvitation(host, 1000, 10);
    const paired = acceptInvitation(invite, host, phone, 20);
    expect(paired.host.id).toBe('host');
    expect(() => acceptInvitation(invite, host, phone, 21)).toThrowError(new PairingError('INVITE_REPLAYED'));
    expect(() => acceptInvitation(issueInvitation(host, 1, 10), host, phone, 11)).toThrowError(new PairingError('INVITE_EXPIRED'));
    expect(() => acceptInvitation(issueInvitation(host), createIdentity('other'), phone)).toThrowError(new PairingError('IDENTITY_MISMATCH'));
  });
  it('authenticates identities and protects frames from replay/tamper/downgrade', () => {
    const host = createIdentity('host'); const phone = createIdentity('phone');
    const invite = issueInvitation(host); const { sessionKey } = acceptInvitation(invite, host, phone);
    const payload = 'pair-v1'; const sig = signHandshake(host, payload);
    expect(verifyHandshake(host, payload, sig)).toBe(true);
    const frame = encryptFrame(sessionKey, host.id, 1, 'hello');
    expect(decryptFrame(sessionKey, frame, host.id, 0).plaintext).toBe('hello');
    expect(() => decryptFrame(sessionKey, frame, host.id, 1)).toThrowError(new PairingError('FRAME_REPLAYED'));
    expect(() => decryptFrame(sessionKey, { ...frame, ciphertext: frame.ciphertext.slice(0, -2) + 'aa' }, host.id, 0)).toThrowError(new PairingError('FRAME_TAMPERED'));
    expect(() => decryptFrame(sessionKey, { ...frame, version: 0 as 1 }, host.id, 0)).toThrowError(new PairingError('PROTOCOL_DOWNGRADE'));
  });
  it('revokes paired devices', () => {
    const registry = new PairingRegistry(); const host = createIdentity('host'); const phone = createIdentity('phone');
    registry.pair({ host: { id: host.id, publicKey: host.publicKey, pairedAt: 1 }, phone: { id: phone.id, publicKey: phone.publicKey, pairedAt: 1 } });
    registry.assertUsable(phone.id); registry.revoke(phone.id); expect(() => registry.assertUsable(phone.id)).toThrowError(new PairingError('REVOKED'));
  });
});
