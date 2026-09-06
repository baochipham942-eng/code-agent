// ============================================================================
// LoopOwnership — running loop 的进程归属判据（N-LOOP-DURABLE 修复棒 Important 1）
//
// CLI 与桌面共用同一个 code-agent.db，且 initializeCLIServices 被 run/export/chat/
// serve/debug/dev 路由等多处入口调用——任何一个 CLI 命令都可能在桌面 loop 正常
// 运行时启动。启动收口因此不能假设「我现在启动 = 上一个进程死了」，那会把桌面
// 正在跑的 loop 收成 failed（当着用户面撒谎）。判据改成随记录走的归属身份：
//   loop 进入 running 时，执行进程把 pid + 进程启动身份盖进 automation 的 config_json；
//   收口时逐条判定归属进程是否「已确认消失」：
//     dead    → pid 已不存在（ESRCH），或 pid 存在但启动身份对不上（pid 被复用）；
//     alive   → pid 存在且身份吻合；或只能做存在性检查（身份任一侧取不到）；
//     unknown → 无归属戳 / 戳不合法——判不出归属就不动手（宁可漏收，不可误杀）。
//
// 第五棒（校时免疫）：启动身份是「同一进程恒定、不随系统校时漂移」的原始读数，
// 两侧读同一份快照做相等比较，判据路径不出现 Date.now()。此前用
// Date.now() - etime 反推墙钟启动时间：Linux 的 etime 来自开机时钟（procps 用
// CLOCK_BOOTTIME），与日期时钟不同源，系统校时 60s 就把推算值整体漂 60s，
// 活进程被误判 pid 复用 → 谎报「循环已中断」。身份确认不了（读不到 / 跨口径 /
// 旧版戳无身份字段）一律 alive 不收口：漏收只是维持现状，误收是当着用户面撒谎。
// 判据修在 markInterruptedLoops 内部而非挑调用点：任何入口调用都天然安全。
// ============================================================================

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type {
  SessionAutomationOwnerIdentity,
  SessionAutomationOwnerStamp,
} from '../../shared/contract/sessionAutomation';

/** ps 探测超时：挂死不许拖住启动收口。 */
const PS_PROBE_TIMEOUT_MS = 5_000;

/** parseLoopOwnerStamp 认的身份口径；与 SessionAutomationOwnerIdentity.source 同步。 */
const IDENTITY_SOURCES = new Set<string>(['linux-proc-stat-starttime', 'darwin-ps-lstart']);

export type LoopOwnerLiveness = 'alive' | 'dead' | 'unknown';

export interface LoopOwnershipProbes {
  /** pid 是否还存在（存在性检查，跨平台）。 */
  isPidAlive(pid: number): boolean;
  /** pid 的启动身份原始观测（同一进程恒定、不随系统校时漂移）；取不到返回 null。
   *  探针只负责读原始观测；口径解释与比较在 resolveLoopOwnerLiveness 里，
   *  判据因此可经注入探针直接覆盖（身份读取器不为测试单独导出）。 */
  readProcessIdentity(pid: number): SessionAutomationOwnerIdentity | null;
}

/** 盖归属戳：记录本进程的 pid 与启动身份。 */
export function captureLoopOwnerStamp(): SessionAutomationOwnerStamp {
  const identity = readProcessIdentityDefault(process.pid);
  return {
    pid: process.pid,
    ...(identity !== null ? { processIdentity: identity } : {}),
    stampedAt: Date.now(),
  };
}

/**
 * 从 automation 行的 config_json 解析归属戳。
 * 无 config、无 ownerProcess 键或字段不合法 → null（收口侧按 unknown 处理，不动手）。
 * 身份字段不合法的戳按「无身份」收：pid 仍可用于存在性检查（pid 不在照样收口）。
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
  const { pid, processIdentity, stampedAt } = owner as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  // stampedAt 仅信息性字段，不参与判活；坏值不拦收口也不伪造，落 0。
  const stamp: SessionAutomationOwnerStamp = {
    pid,
    stampedAt: typeof stampedAt === 'number' && Number.isFinite(stampedAt) ? stampedAt : 0,
  };
  if (isOwnerIdentity(processIdentity)) stamp.processIdentity = processIdentity;
  return stamp;
}

/**
 * 判定归属进程是否已确认消失。只有两种情况算 dead：pid 不存在；或 pid 存在但
 * 启动身份与戳对不上（原进程已退、pid 被复用）。任何判不准（无戳/字段坏/读不到
 * 当前身份/跨口径不可比较）都落在 alive——即不动手，漏收不误杀。
 */
export function resolveLoopOwnerLiveness(
  owner: SessionAutomationOwnerStamp | null,
  probes: LoopOwnershipProbes = defaultProbes,
): LoopOwnerLiveness {
  if (!owner) return 'unknown';
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return 'unknown';
  if (!probes.isPidAlive(owner.pid)) return 'dead';
  const identity = owner.processIdentity;
  if (identity === undefined) return 'alive'; // win32 / 旧版戳：退化为存在性检查
  const observed = probes.readProcessIdentity(owner.pid);
  if (observed === null) return 'alive'; // 当前身份读不到 → 判不准（漏收方向）
  if (observed.source !== identity.source) return 'alive'; // 跨口径数值不可比较
  return observed.value === identity.value ? 'alive' : 'dead'; // 对不上 = pid 复用
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

function isOwnerIdentity(value: unknown): value is SessionAutomationOwnerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { source, value: observed } = value as Record<string, unknown>;
  return typeof source === 'string' && IDENTITY_SOURCES.has(source)
    && typeof observed === 'number' && Number.isFinite(observed);
}

/**
 * Linux：/proc/<pid>/stat 第 22 字段 starttime（开机以来 tick，开机时钟域）。
 * 同一进程恒定、系统校时不影响，pid 复用必变值。comm 可含空格/括号，
 * 从最后一个 ')' 之后取字段（其后第 20 个 = 全局字段 22）。
 */
function readLinuxStarttimeTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) && ticks >= 0 ? ticks : null;
  } catch {
    return null;
  }
}

/**
 * macOS：ps lstart = 内核在 exec 时记录的启动墙钟快照（秒精度），之后系统校时
 * 不回写——读同一进程两次结果恒定。格式解析失败 → null（判不准）。
 */
function readDarwinStartEpochMs(pid: number): number | null {
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: PS_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0) return null;
    const epochMs = Date.parse(result.stdout.trim().replace(/\s+/g, ' '));
    return Number.isFinite(epochMs) ? epochMs : null;
  } catch {
    return null;
  }
}

function readProcessIdentityDefault(pid: number): SessionAutomationOwnerIdentity | null {
  if (process.platform === 'linux') {
    const ticks = readLinuxStarttimeTicks(pid);
    return ticks === null ? null : { source: 'linux-proc-stat-starttime', value: ticks };
  }
  if (process.platform === 'darwin') {
    const epochMs = readDarwinStartEpochMs(pid);
    return epochMs === null ? null : { source: 'darwin-ps-lstart', value: epochMs };
  }
  return null; // win32 等：无口径 → 退化为存在性检查
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
  readProcessIdentity: readProcessIdentityDefault,
};
