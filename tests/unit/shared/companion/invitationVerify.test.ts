import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveInvitationVerify, formatInvitationVerify, parseInvitation,
} from '../../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';

const psk = 'aa'.repeat(32);
const hostKey = 'bb'.repeat(32);
const inviteId = '123e4567-e89b-12d3-a456-426614174000';

function expected(pskHex: string, hostKeyHex: string): string {
  const digest = createHash('sha256').update(Buffer.concat([
    Buffer.from(pskHex, 'hex'), Buffer.from(hostKeyHex, 'hex'),
  ])).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

function raw(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1, endpoint: 'http://192.168.1.2:8182', inviteId, psk, hostKey,
    expiresAt: Date.now() + 60_000, ...overrides,
  });
}

describe('companion invitation verify code', () => {
  it('derives the same 6-digit code from the same psk‖hostKey and a different code from different material', () => {
    const a = deriveInvitationVerify(psk, hostKey);
    expect(a).toBe(expected(psk, hostKey));
    expect(a).toMatch(/^\d{6}$/);
    expect(deriveInvitationVerify(psk, hostKey)).toBe(a);
    expect(deriveInvitationVerify('cc'.repeat(32), hostKey)).not.toBe(a);
    expect(deriveInvitationVerify(psk, 'dd'.repeat(32))).not.toBe(a);
  });

  it('groups six digits as 472 891', () => {
    expect(formatInvitationVerify('472891')).toBe('472 891');
    expect(formatInvitationVerify(deriveInvitationVerify(psk, hostKey))).toMatch(/^\d{3} \d{3}$/);
  });

  it('parses an old invitation with no verify field', () => {
    expect(parseInvitation(raw()).verify).toBeUndefined();
  });

  it('accepts a well-formed 6-digit verify field', () => {
    expect(parseInvitation(raw({ verify: '472891' })).verify).toBe('472891');
  });

  it.each(['47289', '4728910', '47289a', '', 472891, null])('rejects a malformed verify field %j', value => {
    expect(() => parseInvitation(raw({ verify: value }))).toThrow('COMPANION_INVALID_INVITATION');
  });
});

describe('invitation literal candidates (N-COMPANION-MDNS-FALLBACK)', () => {
  it('parses literal candidates through and leaves old invitations untouched', () => {
    const candidates = ['http://10.0.0.5:8182', 'http://192.168.1.9:8182'];
    expect(parseInvitation(raw({ candidates })).candidates).toEqual(candidates);
    // 旧宿主不带 candidates：行为与今天完全一致（字段缺席，不抛、不造默认值）。
    expect(parseInvitation(raw()).candidates).toBeUndefined();
  });

  it('runs every candidate through the endpoint whitelist (与 endpoint/altEndpoint 同一道校验)', () => {
    for (const candidates of [
      ['http://8.8.8.8:8182'], ['http://evil.example:8182'], ['http://10.0.0.5:8182/path'],
      ['https://10.0.0.5:8182'], ['http://10.0.0.5'], ['http://10.0.0.5:8182', 'http://8.8.8.8:8182'],
    ]) {
      expect(() => parseInvitation(raw({ candidates }))).toThrow('COMPANION_INVALID_LAN_ENDPOINT');
    }
    expect(() => parseInvitation(raw({ candidates: [42] }))).toThrow('COMPANION_INVALID_INVITATION');
  });

  it('rejects a candidates field that is not a bounded non-empty array', () => {
    const literal = 'http://10.0.0.5:8182';
    for (const candidates of [literal, [], Array<string>(L.invitationMaxCandidates + 1).fill(literal), null]) {
      expect(() => parseInvitation(raw({ candidates }))).toThrow('COMPANION_INVALID_INVITATION');
    }
    expect(parseInvitation(raw({ candidates: Array<string>(L.invitationMaxCandidates).fill(literal) }))).toBeTruthy();
  });

  it('rejects an invitation whose payload blows the 2048-byte QR budget even with candidates aboard', () => {
    expect(() => parseInvitation(raw({ candidates: ['http://10.0.0.5:8182'], pad: 'x'.repeat(2_100) })))
      .toThrow('COMPANION_INVALID_INVITATION');
  });
});
