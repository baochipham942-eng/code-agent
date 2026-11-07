import { CLI_CONNECTOR_DESCRIPTORS } from '../../../shared/constants/cliConnectorDescriptors';

interface CliConnectorConnectionStatus {
  connected: boolean;
  checkedAt: number;
}

const cliConnectorIds = new Set(CLI_CONNECTOR_DESCRIPTORS.map((descriptor) => descriptor.id));
const statusCache = new Map<string, CliConnectorConnectionStatus>();

export function isCliConnectorId(connectorId: string): boolean {
  return cliConnectorIds.has(connectorId);
}

export function getCachedCliConnectorConnectionStatus(
  connectorId: string,
): CliConnectorConnectionStatus | undefined {
  return statusCache.get(connectorId);
}

export function replaceCliConnectorConnectionStatusCache(
  statuses: Array<{ id: string; connected: boolean }>,
): void {
  statusCache.clear();
  const checkedAt = Date.now();
  for (const status of statuses) {
    if (isCliConnectorId(status.id)) {
      statusCache.set(status.id, { connected: status.connected, checkedAt });
    }
  }
}

// ----------------------------------------------------------------------------
// N-CONNECTOR-POLISH-AUDIT-FU1-FU2：冷缓存时发卡点等待在途/新起的探测。
// 轮级缓存只有 listConnectorOAuthStatuses（connector.ipc）这一个填充者，且是异步的；
// 空缓存按「ready」fail-open，开机后第一轮若在探测落定前判读，未登录的 CLI 连接器
// 会被静默当成已连接而不发连接卡。探测的在途登记和新起入口都收在本模块，
// 让 ipc 层与 turn 判读层（workbenchTurnContext）不互相 import。
// ----------------------------------------------------------------------------

export type CliConnectorStatusProbeResult =
  | { kind: 'filled' }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string }
  | { kind: 'not-registered' };

let inFlightProbe: Promise<unknown> | undefined;
let probeStarter: (() => Promise<unknown>) | undefined;

/**
 * 登记一次在途的状态列举探测（listConnectorOAuthStatuses 的 promise）。
 * settle 后自动注销；拒绝也会被吞掉——探测方自己处理错误，这里只跟踪进度。
 */
export function trackCliConnectorStatusProbe(probe: Promise<unknown>): void {
  inFlightProbe = probe;
  void probe.catch(() => undefined).finally(() => {
    if (inFlightProbe === probe) inFlightProbe = undefined;
  });
}

/**
 * 注册「新起一次探测」的入口（connector.ipc 模块加载时调用一次）。
 * 传 undefined 表示注销（测试复位用）。
 */
export function registerCliConnectorStatusProbeStarter(
  start: (() => Promise<unknown>) | undefined,
): void {
  probeStarter = start;
}

/**
 * 等在途（或新起一次）状态探测落定，最多 timeoutMs。
 * - 在途探测存在 → 直接等它；否则用注册的入口新起一次（新起的同样被登记，并发去重）。
 * - 无在途也无入口 → not-registered（ipc 层没加载，理论上只在测试/裁剪环境出现）。
 * - 超时/失败返回可区分原因，由调用方决定 fail-open 并 warn。
 */
export async function awaitCliConnectorStatusProbe(
  timeoutMs: number,
): Promise<CliConnectorStatusProbeResult> {
  const probe = inFlightProbe ?? probeStarter?.();
  if (!probe) return { kind: 'not-registered' };
  if (!inFlightProbe) trackCliConnectorStatusProbe(probe);

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe.then(
        () => ({ kind: 'filled' }) as CliConnectorStatusProbeResult,
        (error: unknown) => ({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        }) as CliConnectorStatusProbeResult,
      ),
      new Promise<CliConnectorStatusProbeResult>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
