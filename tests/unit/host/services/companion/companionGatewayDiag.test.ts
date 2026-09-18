import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';
import type { CompanionRelayLogger } from '../../../../../src/host/services/companion/companionRelayConfig';

/**
 * 结算链留痕（N-MOBILE-SEND-RESULT-LOST）：CompanionGateway 的可选 logger 在 submit 结论、
 * settleCommand 迁移、publish、启动期回收四处各产出可区分的行。手机 pending 卡死现场里，
 * 「submit 有行、settle 永远无行」就是宿主结算悬挂（断点 D）的判据——所以迁移行必须只在
 * 真迁移（reconciling → 终态）时出现。照 companionRelayCloseDiag 的范式：fake logger 收集
 * 行、断言字段，不看实现；消息正文绝不进日志。
 */

function collectLogger(): { logger: CompanionRelayLogger; info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  return { info, warn, logger: { info: message => info.push(message), warn: message => warn.push(message) } };
}

describe('companion gateway settlement diagnostics', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => db.close());

  const register = (gateway: CompanionGateway) =>
    gateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash-phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
  const command = (commandId: string, deviceId = 'phone-1') => ({
    version: 1 as const, commandId, deviceId, scopeEpoch: 1, sessionId: 'session-1',
    action: 'message.send' as const, payload: { text: 'secret-正文不许进日志' },
  });

  it('logs one settle line only when settleCommand really migrates the reconciling row', async () => {
    const { logger, info, warn } = collectLogger();
    const gateway = new CompanionGateway(db, {
      now: () => 1000,
      // dispatch 返回 reconciling（message.send 的异步结算形状），行先停在 reconciling。
      dispatch: () => ({ state: 'reconciling' as const, result: { code: 'COMMAND_RECONCILING' } }),
      logger,
    });
    register(gateway);
    await gateway.submit(command('cmd-1'));
    // submit 自身会记结论行，但 settle 迁移行在结算前必须一行都没有。
    expect(info.some(line => line.includes('Companion gateway settled:'))).toBe(false);
    gateway.settleCommand('phone-1', 'cmd-1', 'rejected', { code: 'RUN_START_FAILED' });
    expect(info).toContain('Companion gateway settled: action=message.send deviceId=phone-1 commandId=cmd-1 state=rejected code=RUN_START_FAILED');
    // 已终态的行再 settle 不产生第二行（changes=0 不是迁移）。
    gateway.settleCommand('phone-1', 'cmd-1', 'accepted', { runId: 'run-9' });
    expect(info.filter(line => line.includes('Companion gateway settled:'))).toHaveLength(1);
    expect([...info, ...warn].join('\n')).not.toContain('secret-正文不许进日志');
  });

  it('logs submit conclusions: accepted/replayed at info, device-level rejections at warn', async () => {
    const { logger, info, warn } = collectLogger();
    const gateway = new CompanionGateway(db, { now: () => 1000, dispatch: () => ({ state: 'accepted' as const, result: { runId: 'run-1' } }), logger });
    register(gateway);
    await gateway.submit(command('cmd-a'));
    await gateway.submit(command('cmd-a'));
    await gateway.submit(command('cmd-b', 'phone-unknown'));
    await gateway.submit({ nonsense: true });
    expect(info).toContain('Companion gateway submit: action=message.send deviceId=phone-1 commandId=cmd-a kind=accepted');
    expect(info).toContain('Companion gateway submit: action=message.send deviceId=phone-1 commandId=cmd-a kind=replayed');
    expect(warn).toContain('Companion gateway submit: action=message.send deviceId=phone-unknown commandId=cmd-b kind=rejected reason=device_unknown');
    expect(warn).toContain('Companion gateway submit: action=invalid deviceId=- commandId=- kind=rejected reason=invalid_command');
  });

  it('logs each publish with kind/sessionId/seq, and the skip reason when no live device exists', () => {
    const withDevice = collectLogger();
    const gateway = new CompanionGateway(db, { now: () => 1000, logger: withDevice.logger });
    register(gateway);
    gateway.publish('session-1', 'message', { id: 'm1' });
    gateway.publish('session-1', 'run_failed', { id: 'm2' });
    expect(withDevice.info).toContain('Companion gateway published: kind=message sessionId=session-1 seq=1');
    expect(withDevice.info).toContain('Companion gateway published: kind=run_failed sessionId=session-1 seq=2');

    const bare = collectLogger();
    // 另开一个没注册任何设备的库：hasLiveDevices=false，publish 只能跳过。
    const orphanDb = new Database(':memory:');
    const orphan = new CompanionGateway(orphanDb, { now: () => 1000, logger: bare.logger });
    orphan.publish('session-1', 'message', { id: 'm3' });
    orphanDb.close();
    expect(bare.info).toContain('Companion gateway publish skipped: kind=message sessionId=session-1 seq=1 reason=no_live_devices');
  });

  it('logs the startup recovery count when a previous session left reconciling rows', async () => {
    const first = new CompanionGateway(db, {
      now: () => 1000,
      dispatch: () => ({ state: 'reconciling' as const, result: { code: 'COMMAND_RECONCILING' } }),
    });
    register(first);
    await first.submit(command('cmd-hang'));
    const { logger, warn } = collectLogger();
    new CompanionGateway(db, { now: () => 1000, logger });
    expect(warn).toContain('Companion gateway startup recovery: interrupted=1 reconciling command(s)');
  });
});
