import { describe, expect, it } from 'vitest';
import { createIdentity } from '../../../../src/shared/companion/noiseChannel';
import { createRelayPairHandshake, deriveRelayPairVerify, formatRelayPairVerify } from '../../../../src/shared/companion/relayPair';
import { fromHex, toHex } from '../../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';
import {
  COMPANION_RELAY_LIST_HOSTS_ROUTE_TOKEN,
  COMPANION_RELAY_PAIR_ROUTE_TOKEN,
  parseCompanionRelayFrame,
  parseCompanionRelayHostList,
} from '../../../../src/shared/contract/companionRelay';

/**
 * relay 找回（N-COMPANION-RELAY-ACCOUNT-RECOVER）的契约与派生原语：三个新 kind 的形状纪律
 * （.strict()：多一个字段就非法）、register 自报字段的可选性（旧端不带照常解析）、host 列表
 * 解析、4 位核对码派生（同材料同码 / 异材料异码 / 4 位格式）。
 */

const envelope = { routeToken: COMPANION_RELAY_PAIR_ROUTE_TOKEN, deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() };
const FINGERPRINT = 'a'.repeat(64);

describe('companionRelay contract：找回三个新 kind', () => {
  it('list-hosts 请求（空 ciphertext）与回帧（JSON 列表）同一个 kind 都解析', () => {
    expect(parseCompanionRelayFrame({ v: 1, kind: 'list-hosts', envelope: { ...envelope, routeToken: COMPANION_RELAY_LIST_HOSTS_ROUTE_TOKEN }, ciphertext: '' }).kind).toBe('list-hosts');
    expect(parseCompanionRelayFrame({ v: 1, kind: 'list-hosts', envelope: { ...envelope, routeToken: COMPANION_RELAY_LIST_HOSTS_ROUTE_TOKEN }, ciphertext: '[]' }).kind).toBe('list-hosts');
  });

  it('pair-request：带 instanceId（初次）与不带（续帧）都合法；requestId 形状不对拒', () => {
    const initial = parseCompanionRelayFrame({ v: 1, kind: 'pair-request', requestId: 'request-id-1234567890', instanceId: 'instance-id-1234567890', envelope, ciphertext: 'ab' });
    expect(initial.kind === 'pair-request' && initial.instanceId).toBe('instance-id-1234567890');
    const continuation = parseCompanionRelayFrame({ v: 1, kind: 'pair-request', requestId: 'request-id-1234567890', envelope, ciphertext: 'ab' });
    expect(continuation.kind === 'pair-request' && continuation.instanceId).toBeUndefined();
    expect(() => parseCompanionRelayFrame({ v: 1, kind: 'pair-request', requestId: 'short', envelope, ciphertext: 'ab' })).toThrow('COMPANION_RELAY_INVALID_FRAME');
  });

  it('pair-result：accepted/reason/stage 的组合形状；未知 reason 拒；多余字段拒（strict）', () => {
    const denied = parseCompanionRelayFrame({ v: 1, kind: 'pair-result', requestId: 'request-id-1234567890', accepted: false, reason: 'host-offline', envelope, ciphertext: '' });
    expect(denied.kind === 'pair-result' && denied.reason).toBe('host-offline');
    const reply = parseCompanionRelayFrame({ v: 1, kind: 'pair-result', requestId: 'request-id-1234567890', accepted: true, stage: 'reply', envelope, ciphertext: 'ab'.repeat(48) });
    expect(reply.kind === 'pair-result' && reply.stage).toBe('reply');
    expect(() => parseCompanionRelayFrame({ v: 1, kind: 'pair-result', requestId: 'request-id-1234567890', accepted: false, reason: 'kaput', envelope, ciphertext: '' })).toThrow();
    expect(() => parseCompanionRelayFrame({ v: 1, kind: 'pair-result', requestId: 'request-id-1234567890', accepted: true, stage: 'reply', envelope, ciphertext: 'ab', extra: 1 })).toThrow();
  });

  it('register 自报字段：hostName/hostKeyFingerprint 可选（旧端不带照常解析），坏值拒', () => {
    const base = { v: 1 as const, kind: 'register' as const, role: 'host' as const, envelope, ciphertext: '' };
    const bare = parseCompanionRelayFrame(base);
    expect(bare.kind === 'register' && bare.hostKeyFingerprint).toBeUndefined();
    expect(parseCompanionRelayFrame({ ...base, hostName: "Lin's MacBook Pro", hostKeyFingerprint: FINGERPRINT })).toMatchObject({ hostName: "Lin's MacBook Pro", hostKeyFingerprint: FINGERPRINT });
    // 指纹不是 64 位 hex（旧手机 register 为 device 角色不带它，但带了就必须对形状）
    expect(() => parseCompanionRelayFrame({ ...base, hostKeyFingerprint: 'not-hex' })).toThrow();
    expect(() => parseCompanionRelayFrame({ ...base, hostName: 'x'.repeat(L.relayHostNameLength + 1) })).toThrow();
  });

  it('parseCompanionRelayHostList：合法列表/空串指纹（旧 Host 降级）/未知字段拒/超上限拒', () => {
    expect(parseCompanionRelayHostList([{ name: 'Mac', fingerprint: FINGERPRINT, instanceId: 'instance-id-1234567890' }]))
      .toEqual([{ name: 'Mac', fingerprint: FINGERPRINT, instanceId: 'instance-id-1234567890' }]);
    expect(parseCompanionRelayHostList([{ name: '', fingerprint: '', instanceId: 'instance-id-1234567890' }]))
      .toEqual([{ name: '', fingerprint: '', instanceId: 'instance-id-1234567890' }]);
    expect(parseCompanionRelayHostList([])).toEqual([]);
    expect(() => parseCompanionRelayHostList([{ name: 'Mac', fingerprint: FINGERPRINT, instanceId: 'instance-id-1234567890', pairedAt: 1 }])).toThrow('COMPANION_RELAY_INVALID_HOST_LIST');
    expect(() => parseCompanionRelayHostList(Array.from({ length: L.relayMaxRoutesPerAccount + 1 }, () => ({ name: 'a', fingerprint: '', instanceId: 'instance-id-1234567890' })))).toThrow();
  });
});

describe('relay 找回核对码与纯 XX 握手', () => {
  it('同握手材料同码、异材料异码、4 位格式（派生自 XX 第一条消息的临时公钥）', () => {
    const materialA = fromHex('ab'.repeat(32));
    const materialB = fromHex('cd'.repeat(32));
    const codeA = deriveRelayPairVerify(materialA);
    expect(codeA).toBe(deriveRelayPairVerify(materialA));
    expect(codeA).toMatch(/^\d{4}$/);
    expect(deriveRelayPairVerify(materialB)).toMatch(/^\d{4}$/);
    // 固定材料固定码：这两条互异是确定性的（sha256 固定输入）
    expect(deriveRelayPairVerify(materialA)).not.toBe(deriveRelayPairVerify(materialB));
  });

  it('formatRelayPairVerify：S6 稿形状 4719 → "4 7 1 9"', () => {
    expect(formatRelayPairVerify('4719')).toBe('4 7 1 9');
  });

  it('纯 XX 三消息交换：两端 complete、互认静态公钥、prologue 域分隔可用', () => {
    const host = createIdentity();
    const phone = createIdentity();
    const initiator = createRelayPairHandshake(true, phone);
    const responder = createRelayPairHandshake(false, host);
    const msg1 = initiator.send();
    expect(responder.recv(msg1).length).toBe(0);
    expect(toHex(responder.re!)).toBe(toHex(initiator.e!.publicKey));
    const msg2 = responder.send();
    expect(initiator.recv(msg2).length).toBe(0);
    expect(toHex(initiator.rs!)).toBe(toHex(host.publicKey));
    const msg3 = initiator.send();
    expect(responder.recv(msg3).length).toBe(0);
    expect(initiator.complete).toBe(true);
    expect(responder.complete).toBe(true);
    expect(toHex(responder.rs!)).toBe(toHex(phone.publicKey));
  });
});
