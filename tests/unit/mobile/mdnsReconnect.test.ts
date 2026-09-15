import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import { mdnsRefreshedEndpoint } from '../../../packages/mobile/src/platform/mdnsEndpoint';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

// fix4-⑤（2026-09-15）：重连先按绑定里的主机名重新做 mDNS 解析，治「电脑换网后手机死磕
// 旧 IP」。解析到用新地址并更新绑定 endpoint；解析不到回退旧地址，pairing 语义不变。
const harness = vi.hoisted(() => ({
  recoverTarget: null as { endpoint: string; altEndpoint?: string } | null,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() { throw new Error('COMPANION_PAIRING_REJECTED'); }
    async recover(target: { endpoint: string; altEndpoint?: string }) {
      harness.recoverTarget = target;
      return { version: 1 as const, endpoint: target.endpoint, ...(target.altEndpoint ? { altEndpoint: target.altEndpoint } : {}),
        hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] };
    }
    async request() { return { kind: 'events', epoch: 1, nextSeq: 0, events: [] }; }
    close() {}
  },
}));

const OLD = { endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182' };

describe('mdnsRefreshedEndpoint：地址换算规则（经它消费 reResolvedEndpoint）', () => {
  const resolver = (address: string | null) => ({ resolveHost: async () => address });
  it('解析不到（null/抛错）不换地址——调用方回退旧 IP', async () => {
    expect(await mdnsRefreshedEndpoint(resolver(null), OLD)).toBeNull();
    expect(await mdnsRefreshedEndpoint({ resolveHost: async () => { throw new Error('DNS_UNRESOLVED'); } }, OLD)).toBeNull();
  });
  it('解析到旧地址/非私网 IPv4/endpoint 形状不对都不换（不换身份、不引外网地址）', async () => {
    expect(await mdnsRefreshedEndpoint(resolver('192.168.1.2'), OLD)).toBeNull();
    expect(await mdnsRefreshedEndpoint(resolver('8.8.8.8'), OLD)).toBeNull();
    expect(await mdnsRefreshedEndpoint(resolver('192.168.2.9'), { endpoint: 'not a url', altEndpoint: OLD.altEndpoint })).toBeNull();
  });
  it('解析到新私网地址：换 hostname，port 与 altEndpoint 原样保留', async () => {
    expect(await mdnsRefreshedEndpoint(resolver('192.168.2.9'), OLD))
      .toEqual({ endpoint: 'http://192.168.2.9:8182', altEndpoint: 'http://imac.local:8182' });
  });
  it('没有 altEndpoint / 没有该口 / 名字不是 .local 都不进解析', async () => {
    expect(await mdnsRefreshedEndpoint(undefined, OLD)).toBeNull();
    expect(await mdnsRefreshedEndpoint(resolver('192.168.2.9'), { endpoint: OLD.endpoint })).toBeNull();
    expect(await mdnsRefreshedEndpoint(resolver('192.168.2.9'), { endpoint: OLD.endpoint, altEndpoint: 'http://192.168.1.5:8182' })).toBeNull();
  });
});

function savedBinding(address: string): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: address, altEndpoint: 'http://imac.local:8182',
      hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] },
  });
}

function storeWith(resolveHost: (() => Promise<string | null>) | null) {
  const writes: string[] = [];
  const companion: NonNullable<PlatformPorts['companion']> = {
    read: async () => savedBinding('http://192.168.1.2:8182'),
    write: async value => { writes.push(value); },
    scan: async () => { throw new Error('unused'); },
    post: async () => ({}),
    ...(resolveHost ? { resolveHost } : {}),
  };
  return { store: createCompanionStore(companion, () => {}), writes };
}

describe('companionStore.reconnect：先 mDNS 重解析再拨', () => {
  it('解析到新地址：recover 拨新地址，绑定 endpoint 被更新（身份字段不动）', async () => {
    const { store, writes } = storeWith(async () => '192.168.2.9');
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    expect(harness.recoverTarget?.endpoint).toBe('http://192.168.2.9:8182');
    expect(harness.recoverTarget?.altEndpoint).toBe('http://imac.local:8182');
    expect(store.getState().binding?.endpoint).toBe('http://192.168.2.9:8182');
    // 落盘的绑定：地址换了，hostKey/deviceId/scopeEpoch/scope 原样——不换身份。
    const persisted = JSON.parse(writes.at(-1) ?? '{}');
    expect(persisted.binding.endpoint).toBe('http://192.168.2.9:8182');
    expect(persisted.binding.hostKey).toHaveLength(64);
    expect(persisted.binding.deviceId).toBe('phone-1');
    expect(persisted.binding.scopeEpoch).toBe(1);
    expect(persisted.binding.scope).toEqual(['project:one']);
  });

  it('解析不到：回退绑定里的旧地址（行为不劣化）', async () => {
    const { store } = storeWith(async () => null);
    await store.getState().hydrate();
    expect(harness.recoverTarget?.endpoint).toBe('http://192.168.1.2:8182');
    expect(store.getState().binding?.endpoint).toBe('http://192.168.1.2:8182');
  });

  it('没有原生解析口（老 port 形状）：照旧直接拨绑定地址', async () => {
    const { store } = storeWith(null);
    await store.getState().hydrate();
    expect(harness.recoverTarget?.endpoint).toBe('http://192.168.1.2:8182');
  });
});

// JS↔原生合同（照 iosNativeVoicePlugin.test.ts 的先例）：名字错一个字，桥就找不到实现。
describe('LanDns 第一方插件合同（iOS / Android / JS 三侧）', () => {
  const swift = readFileSync('packages/mobile/ios-native/NeoLanDnsPlugin.swift', 'utf8');
  const buildIos = readFileSync('packages/mobile/scripts/build-ios.mjs', 'utf8');
  const buildAndroid = readFileSync('packages/mobile/scripts/build-android.mjs', 'utf8');
  const configureLan = readFileSync('packages/mobile/scripts/configure-lan.mjs', 'utf8');
  const nativeCompanion = readFileSync('packages/mobile/src/platform/nativeCompanion.ts', 'utf8');
  const portsFile = readFileSync('packages/mobile/src/platform/ports.ts', 'utf8');

  it('iOS：jsName/js 注册名/方法三处同名，且注册进 packageClassList 与二进制闸', () => {
    const objcName = swift.match(/@objc\((\w+)\)/)?.[1];
    expect(swift).toContain('public let jsName = "LanDns"');
    expect(swift).toContain(`public let identifier = "${objcName}"`);
    expect(swift).toContain('CAPPluginMethod(name: "resolve"');
    expect(swift).toContain('@objc func resolve(');
    expect(buildIos).toContain(`nativeClass: '${objcName}'`);
    expect(buildIos).toContain('IOS_LAN_DNS_PLUGIN_MISSING_FROM_BINARY');
  });

  it('Android：插件生成 + MainActivity 在 super.onCreate 前注册 + 组播权限', () => {
    expect(buildAndroid).toContain('LanDnsPlugin.java');
    expect(buildAndroid).toContain('@CapacitorPlugin(name = "LanDns")');
    expect(buildAndroid).toContain('registerPlugin(LanDnsPlugin.class);');
    // registerPlugin 必须发生在 super.onCreate 之前：BridgeActivity 在自己的 onCreate 里就把 bridge 建完。
    const main = buildAndroid.indexOf('registerPlugin(LanDnsPlugin.class);');
    expect(buildAndroid.indexOf('super.onCreate(savedInstanceState);', main)).toBeGreaterThan(main);
    expect(configureLan).toContain('ensureAndroidMulticastPermission');
    expect(configureLan).toContain('android.permission.CHANGE_WIFI_MULTICAST_STATE');
  });

  it('JS：companion 口声明 resolveHost，nativeCompanion 用 LanDns 桥并带超时', () => {
    expect(portsFile).toContain('resolveHost?(host: string): Promise<string | null>');
    expect(nativeCompanion).toContain("import { LanDns } from './lanDns'");
    expect(nativeCompanion).toContain('LanDns.resolve({ host, timeoutMs: L.mdnsResolveTimeoutMs })');
    expect(nativeCompanion).toContain('isPrivateIPv4(address) ? address : null');
  });

  it('超时唯一真源在 COMPANION_LIMITS（原生两侧由 JS 传参消费）', () => {
    expect(COMPANION_LIMITS.mdnsResolveTimeoutMs).toBe(3_000);
    expect(swift).toContain('call.getInt("timeoutMs")');
    expect(buildAndroid).toContain('call.getInt("timeoutMs"');
  });
});
