import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * N-MOBILE-CONN-POLISH-R3 ①手机侧：nativeCompanion.post 对 exchange 403 的 body 判读
 * （宿主把「设备已撤销」从笼统 403 里拆出来，手机要认出这个点名；旧宿主/其余形状维持原行为）。
 * 该模块 import 的 capacitor 依赖不进根依赖树（packages/mobile 独立锁），测试程序里
 * import 不动它——按 iosNativeVoicePlugin/iosPackage 的先例做源码契约；行为级端到端
 * （宿主 exchange 回名 + 手机映射 + store 结算）由 tests/integration/companionLan.test.ts
 * 的撤销用例钉住，那里的 post 助手复刻的正是这里的映射。
 */
const source = readFileSync('packages/mobile/src/platform/nativeCompanion.ts', 'utf8');

describe('nativeCompanion.post 的 403 映射（源码契约）', () => {
  it('exchange 的 403 读 body：error === COMPANION_DEVICE_REVOKED 时上抛同名错误码', () => {
    expect(source).toContain("target.pathname === '/v1/exchange'");
    expect(source).toContain("(response.data as { error?: unknown } | null)?.error === 'COMPANION_DEVICE_REVOKED'");
    expect(source).toContain("throw new Error('COMPANION_DEVICE_REVOKED')");
  });

  it('点名判读在兜底 NETWORK_UNAVAILABLE 之前：其余形状（旧宿主的 CHANNEL_CLOSED）维持「没回应」', () => {
    const named = source.indexOf("?.error === 'COMPANION_DEVICE_REVOKED'");
    const fallback = source.indexOf("if (response.status !== 200 || response.url !== url) throw new Error('COMPANION_NETWORK_UNAVAILABLE')");
    expect(named).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(named);
  });

  it('非 exchange 路径的 403（hello/finish）仍只看状态码：配对被拒，不看 body', () => {
    expect(source).toContain("response.status === 403 && target.pathname !== '/v1/exchange'");
    expect(source).toContain("throw new Error('COMPANION_PAIRING_REJECTED')");
  });
});
