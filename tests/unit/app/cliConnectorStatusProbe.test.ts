// ============================================================================
// N-CONNECTOR-POLISH-AUDIT-FU1-FU2：cliConnectorStatusCache 的探测等待单元件。
// 本文件刻意不 import connector.ipc（那会注册「新起探测」入口），not-registered
// 分支只有在入口未注册时才测得到。
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import {
  awaitCliConnectorStatusProbe,
  getCachedCliConnectorConnectionStatus,
  registerCliConnectorStatusProbeStarter,
  replaceCliConnectorConnectionStatusCache,
  trackCliConnectorStatusProbe,
} from '../../../src/host/connectors/cli/cliConnectorStatusCache';

describe('awaitCliConnectorStatusProbe', () => {
  afterEach(() => {
    registerCliConnectorStatusProbeStarter(undefined);
    // 用一个立即落定的探测把在途登记冲掉，模块级状态不跨用例泄漏
    trackCliConnectorStatusProbe(Promise.resolve('reset'));
  });

  it('无在途探测且入口未注册 → not-registered', async () => {
    registerCliConnectorStatusProbeStarter(undefined);
    await expect(awaitCliConnectorStatusProbe(50)).resolves.toEqual({ kind: 'not-registered' });
  });

  it('在途探测落定 → filled', async () => {
    trackCliConnectorStatusProbe(Promise.resolve(['status']));
    await expect(awaitCliConnectorStatusProbe(1_000)).resolves.toEqual({ kind: 'filled' });
  });

  it('在途探测拒绝 → error 带原始错误消息', async () => {
    trackCliConnectorStatusProbe(Promise.reject(new Error('lark-cli exploded')));
    await expect(awaitCliConnectorStatusProbe(1_000)).resolves.toEqual({ kind: 'error', message: 'lark-cli exploded' });
  });

  it('探测一直不落定 → 有界等待后 timeout', async () => {
    trackCliConnectorStatusProbe(new Promise(() => {}));
    const startedAt = Date.now();
    await expect(awaitCliConnectorStatusProbe(80)).resolves.toEqual({ kind: 'timeout' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(70);
  });

  it('无在途但有注册入口 → 新起一次探测；新起的同样被登记，并发等待复用同一次', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    registerCliConnectorStatusProbeStarter(() => {
      started += 1;
      return gate.then(() => 'statuses');
    });
    const first = awaitCliConnectorStatusProbe(1_000);
    const second = awaitCliConnectorStatusProbe(1_000);
    release();
    await expect(first).resolves.toEqual({ kind: 'filled' });
    await expect(second).resolves.toEqual({ kind: 'filled' });
    expect(started).toBe(1);
  });

  it('探测 settle 后在途登记被注销，等待计数回到入口新起', async () => {
    let started = 0;
    registerCliConnectorStatusProbeStarter(() => {
      started += 1;
      return Promise.resolve('statuses');
    });
    await expect(awaitCliConnectorStatusProbe(1_000)).resolves.toEqual({ kind: 'filled' });
    expect(started).toBe(1);
    await expect(awaitCliConnectorStatusProbe(1_000)).resolves.toEqual({ kind: 'filled' });
    expect(started).toBe(2);
  });
});

// 缓存模块基础行为回归（replaceCli… 的既有语义，顺手钉住不被探测改造波及）
describe('cliConnectorStatusCache 基础语义', () => {
  it('replace 覆盖写入且只收 CLI id；空数组清空', () => {
    replaceCliConnectorConnectionStatusCache([
      { id: 'feishu', connected: true },
      { id: 'mail', connected: true },
    ]);
    expect(getCachedCliConnectorConnectionStatus('feishu')).toEqual({
      connected: true,
      checkedAt: expect.any(Number),
    });
    expect(getCachedCliConnectorConnectionStatus('mail')).toBeUndefined();
    replaceCliConnectorConnectionStatusCache([]);
    expect(getCachedCliConnectorConnectionStatus('feishu')).toBeUndefined();
  });
});
