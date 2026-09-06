// ============================================================================
// LoopOwnership — running loop 的进程归属判据（N-LOOP-DURABLE 修复棒 Important 1）
//
// CLI 与桌面共用同一个 code-agent.db，且 initializeCLIServices 被 run/export/chat/
// serve/debug/dev 路由等多处入口调用——任何一个 CLI 命令都可能在桌面 loop 正常
// 运行时启动。启动收口因此不能假设「我现在启动 = 上一个进程死了」，那会把桌面
// 正在跑的 loop 收成 failed（当着用户面撒谎）。判据改成随记录走的归属身份：
//   loop 进入 running 时，执行进程把 pid + 进程启动时间盖进 automation 的 config_json；
//   收口时逐条判定归属进程是否「已确认消失」：
//     dead    → pid 已不存在（ESRCH），或 pid 存在但启动时间对不上（pid 被复用）；
//     alive   → pid 存在且身份吻合；或只能做存在性检查（启动时间任一侧取不到）；
//     unknown → 无归属戳 / 戳不合法——判不出归属就不动手（宁可漏收，不可误杀）。
// 判据修在 markInterruptedLoops 内部而非挑调用点：任何入口调用都天然安全。
// ============================================================================

import { spawnSync } from 'node:child_process';
import type { SessionAutomationOwnerStamp } from '../../shared/contract/sessionAutomation';

/** 启动时间比较容差：ps etime 只有秒级精度，容忍 ±5s。 */
const START_TIME_TOLERANCE_MS = 5_000;

/** ps -o etime 可用的平台；win32 无 ps → 启动时间取不到，退化为纯存在性检查。 */
const PS_ETIME_PLATFORMS = new Set(['darwin', 'linux']);

/** ps 探测超时：挂死不许拖住启动收口。 */
const PS_PROBE_TIMEOUT_MS = 5_000;

export type LoopOwnerLiveness = 'alive' | 'dead' | 'unknown';

export interface LoopOwnershipProbes {
  /** pid 是否还存在（存在性检查，跨平台）。 */
  isPidAlive(pid: number): boolean;
  /** pid 的 ps etime 原始输出（[[dd-]hh:]mm:ss）；取不到返回 null。
   *  探针只负责读原始观测；格式解释与换算在 resolveLoopOwnerLiveness 里，
   *  解析因此可经注入探针直接覆盖（parsePsEtime 不为测试单独导出）。 */
  readProcessEtime(pid: number): string | null;
}

/** 盖归属戳：记录本进程的 pid 与启动时间。 */
export function captureLoopOwnerStamp(): SessionAutomationOwnerStamp {
  const processStartAtMs = processStartAtMsFromEtime(readProcessEtimeDefault(process.pid));
  return {
    pid: process.pid,
    ...(processStartAtMs !== null ? { processStartAtMs } : {}),
    stampedAt: Date.now(),
  };
}

/**
 * 从 automation 行的 config_json 解析归属戳。
 * 无 config、无 ownerProcess 键或字段不合法 → null（收口侧按 unknown 处理，不动手）。
 */
export function parseLoopOwnerStamp(
  configJson: string | null | undefined,
): SessionAutomationOwnerStamp | null {
  if (!configJson) return null;
  let config: unknown;
  try {
    config = JSON.parse(configJson);
  } catch {
    return null;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const owner = (config as Record<string, unknown>).ownerProcess;
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null;
  const { pid, processStartAtMs, stampedAt } = owner as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  // stampedAt 仅信息性字段，不参与判活；坏值不拦收口也不伪造，落 0。
  const stamp: SessionAutomationOwnerStamp = {
    pid,
    stampedAt: typeof stampedAt === 'number' && Number.isFinite(stampedAt) ? stampedAt : 0,
  };
  if (typeof processStartAtMs === 'number' && Number.isFinite(processStartAtMs)) {
    stamp.processStartAtMs = processStartAtMs;
  }
  return stamp;
}

/**
 * 判定归属进程是否已确认消失。只有两种情况算 dead：pid 不存在；或 pid 存在但
 * 启动时间与戳对不上（原进程已退、pid 被复用）。任何判不准（无戳/字段坏/读不到
 * 当前启动时间）都落在 alive/unknown——即不动手，漏收不误杀。
 */
export function resolveLoopOwnerLiveness(
  owner: SessionAutomationOwnerStamp | null,
  probes: LoopOwnershipProbes = defaultProbes,
): LoopOwnerLiveness {
  if (!owner) return 'unknown';
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return 'unknown';
  if (!probes.isPidAlive(owner.pid)) return 'dead';
  if (owner.processStartAtMs === undefined) return 'alive';
  const observedStart = processStartAtMsFromEtime(probes.readProcessEtime(owner.pid));
  if (observedStart === null) return 'alive';
  return Math.abs(observedStart - owner.processStartAtMs) > START_TIME_TOLERANCE_MS
    ? 'dead'
    : 'alive';
}

/**
 * 收口时从 config_json 里摘掉归属戳，返回应写回的 config 串。
 * 解析不了（坏 JSON / 非 object）时原样返回入参——收口只改 status，不破坏原 config。
 */
export function stripLoopOwnerStamp(configJson: string | null | undefined): string | null | undefined {
  if (!configJson) return configJson;
  try {
    const config = JSON.parse(configJson) as unknown;
    if (!config || typeof config !== 'object' || Array.isArray(config)) return configJson;
    delete (config as Record<string, unknown>).ownerProcess;
    return JSON.stringify(config);
  } catch {
    return configJson;
  }
}

/** ps etime 输出（[[dd-]hh:]mm:ss）→ 毫秒；不认识的格式返回 null。 */
function parsePsEtime(text: string): number | null {
  const match = /^(?:(\d+)-)?(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const [, days, high, mid, sec] = match;
  const hours = sec !== undefined ? Number(high) : 0;
  const minutes = sec !== undefined ? Number(mid) : Number(high);
  const seconds = sec !== undefined ? Number(sec) : Number(mid);
  return ((Number(days ?? 0) * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000;
}

/** etime 原文 → 进程启动时间（epoch ms）；取不到或格式不认识 → null（判不准）。 */
function processStartAtMsFromEtime(etime: string | null): number | null {
  if (etime === null) return null;
  const elapsedMs = parsePsEtime(etime);
  return elapsedMs === null ? null : Date.now() - elapsedMs;
}

function readProcessEtimeDefault(pid: number): string | null {
  if (!PS_ETIME_PLATFORMS.has(process.platform)) return null;
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'etime='], {
      timeout: PS_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout ?? '';
  } catch {
    return null;
  }
}

const defaultProbes: LoopOwnershipProbes = {
  isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0); // 信号 0 = 只探测存在性，不真发信号
      return true;
    } catch (error) {
      // EPERM 等 = 进程在但无权限 → 活着；ESRCH = 不在。判不准一律按活着（漏收方向）。
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  },
  readProcessEtime: readProcessEtimeDefault,
};
