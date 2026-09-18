import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N-MOBILE-CONN-POLISH-R3 ①手机侧：nativeCompanion.post 对 exchange 403 的 body 判读。
 * 宿主把「设备已撤销」从笼统 403 里拆出来后，手机要能认出这个点名；旧宿主/其余形状
 * （含 TTL 过期的 CHANNEL_CLOSED）必须维持原行为。集成测试里那段映射是本函数的复刻，
 * 真身在这里钉住。
 */
const http = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  CapacitorHttp: { post: http.post },
  // lanDns.ts 经 registerPlugin 拿原生插件句柄；web 兜底实现足以让模块加载。
  registerPlugin: (_name: string, impl?: unknown) => impl ?? {},
}));
// 本机不装 mobile 的 capacitor 依赖树（packages/mobile 独立锁）；post() 不触键链存储，
// 这两个只用 mock 占位让模块可加载。真机路径的键链行为不在本测试范围。
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: {}, KeychainAccess: {} }));

const { nativeCompanionPort } = await import('../../../packages/mobile/src/platform/nativeCompanion');

const LAN = 'http://192.168.1.2:8182';

function reply(url: string, status: number, data: unknown) {
  http.post.mockResolvedValueOnce({ url, status, data });
}

describe('nativeCompanion.post 的 403 映射', () => {
  beforeEach(() => { http.post.mockReset(); });

  it('exchange 403 点名设备已撤销 ⇒ 上抛 COMPANION_DEVICE_REVOKED（store 按 revoked 结算）', async () => {
    reply(`${LAN}/v1/exchange`, 403, { error: 'COMPANION_DEVICE_REVOKED' });
    await expect(nativeCompanionPort.post(`${LAN}/v1/exchange`, {})).rejects.toThrow('COMPANION_DEVICE_REVOKED');
  });

  it('exchange 403 其余形状（旧宿主的 CHANNEL_CLOSED）⇒ 维持「没回应」', async () => {
    reply(`${LAN}/v1/exchange`, 403, { error: 'COMPANION_CHANNEL_CLOSED' });
    await expect(nativeCompanionPort.post(`${LAN}/v1/exchange`, {})).rejects.toThrow('COMPANION_NETWORK_UNAVAILABLE');
  });

  it('非 exchange 路径的 403（hello/finish）⇒ 配对被拒，不看 body', async () => {
    reply(`${LAN}/v1/hello`, 403, { error: 'COMPANION_DEVICE_REVOKED' });
    await expect(nativeCompanionPort.post(`${LAN}/v1/hello`, {})).rejects.toThrow('COMPANION_PAIRING_REJECTED');
  });

  it('200 原样返回 body', async () => {
    reply(`${LAN}/v1/exchange`, 200, { frame: ['ab'] });
    await expect(nativeCompanionPort.post(`${LAN}/v1/exchange`, {})).resolves.toEqual({ frame: ['ab'] });
  });
});
