import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import type { CompanionRelayLegacyUsage } from '../../../shared/contract/companionManagement';
import { errorHead, logCompanionRelayInfo, type CompanionRelayLogger } from './companionRelayConfig';

/**
 * 共享凭据通道的存量清点（N-COMPANION-RELAY-LEGACY-COUNT）。relay 服务端只认 route token 不认
 * 设备 id，按设备去重只能在 Host 侧做；Host 在 legacy 通道的握手被接受（sessions.set 之后）时记
 * deviceId → lastSeenAt。要回答的问题是「旧凭据还有没有人用」：计数停在 0 一段时间 ⇒ 可以安全下线。
 * 落盘与票据同款（数据目录、原子写、0600）；只统计，不影响任何握手/路由行为。
 */

interface StoredLegacyUsage {
  v: 1;
  /** deviceId → lastSeenAt（epoch ms）。 */
  devices: Record<string, number>;
}

/** 记账器面：client 只用 record，装配层/设置页诊断用 summary。 */
export interface CompanionRelayLegacyUsageRecorder {
  /** 记一笔「设备 D 于 now 经共享凭据通道到达」；去重、按需落盘，永不抛（含落盘失败）。 */
  record(deviceId: string, at?: number): void;
  summary(): CompanionRelayLegacyUsage;
}

function usagePath(dataDirectory: string): string {
  return resolve(dataDirectory, L.relayLegacyUsageFile);
}

function parseStoredUsage(text: string): Record<string, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Partial<StoredLegacyUsage>;
  if (record.v !== 1 || !record.devices || typeof record.devices !== 'object' || Array.isArray(record.devices)) return null;
  const devices: Record<string, number> = {};
  for (const [deviceId, lastSeenAt] of Object.entries(record.devices)) {
    if (!deviceId || typeof lastSeenAt !== 'number' || !Number.isSafeInteger(lastSeenAt) || lastSeenAt < 0) return null;
    devices[deviceId] = lastSeenAt;
  }
  return devices;
}

export function createCompanionRelayLegacyUsage(opts: {
  dataDirectory: string;
  logger?: CompanionRelayLogger;
  now?: () => number;
}): CompanionRelayLegacyUsageRecorder {
  const log = opts.logger;
  const now = opts.now ?? Date.now;
  const path = usagePath(opts.dataDirectory);
  let devices: Record<string, number> = {};
  let loaded = false;
  const load = (): void => {
    if (loaded) return;
    loaded = true;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      // 没有文件是常态（第一次跑/旧凭据从没人用过），不是故障，不叫。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log?.warn(`Companion relay legacy usage file unreadable: ${errorHead(error)}; starting empty`);
      }
      return;
    }
    const parsed = parseStoredUsage(text);
    if (!parsed) {
      log?.warn('Companion relay legacy usage file corrupt; starting empty');
      return;
    }
    devices = parsed;
  };
  const persist = (): void => {
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, devices } satisfies StoredLegacyUsage), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      // 记账是纯观测：落盘失败只留痕，不能把握手帧处理一起拖死（错题本：降级路径必须留痕）。
      log?.warn(`Companion relay legacy usage store write failed: ${errorHead(error)}`);
    }
  };
  return {
    record(deviceId: string, at: number = now()): void {
      if (!deviceId || !Number.isSafeInteger(at) || at < 0) return;
      load();
      const previous = devices[deviceId];
      // 时间没前进（重复握手/时钟回拨）不写盘：不变化的记录没有落盘价值，还放大磁盘磨损。
      if (previous !== undefined && at <= previous) return;
      const isNew = previous === undefined;
      devices[deviceId] = at;
      const entries = Object.entries(devices);
      if (entries.length > L.relayLegacyUsageMaxDevices) {
        // 超上限淘汰 lastSeenAt 最旧的：统计的是「活跃存量」，最久没到的最不构成保留理由。
        let oldest = entries[0];
        for (const entry of entries) if (entry[1] < oldest[1]) oldest = entry;
        delete devices[oldest[0]];
      }
      persist();
      // 只有新设备才出 info：既有设备每次重连都握手，按次打日志就是握手级刷屏。
      if (isNew) {
        const newest = Math.max(...Object.values(devices));
        logCompanionRelayInfo(log, `Companion relay legacy usage: new device recorded; devices=${Object.keys(devices).length} lastSeenAt=${newest}`);
      }
    },
    summary(): CompanionRelayLegacyUsage {
      load();
      const seen = Object.values(devices);
      return { devices: seen.length, lastSeenAt: seen.length ? Math.max(...seen) : null };
    },
  };
}
