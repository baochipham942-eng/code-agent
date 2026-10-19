// ============================================================================
// Daemon State File — ADR-083 `neo daemon status` 的留守原因数据面
// ============================================================================
// daemon 在 pid 文件（daemon.pid）旁维护一份小状态文件 daemon-state.json：当前
// 退出意图 + 留守原因清单。写入方是 daemon 进程（daemonStateReporter，原子写，
// 快照/意图变化时才写）；读取方是 `neo daemon status`（pid 状态为 owned 时打印，
// pid 不吻合 / 解析失败按陈旧文件忽略——那是上一个 daemon 或写失败的残留）。
// 文件只服务本地 CLI 观测，不进任何判据：去留真源仍是 daemonIdle 的纯判据。
// ============================================================================

import fs from 'fs';
import path from 'path';
import type { DaemonQuitIntent, DaemonStayReason } from './daemonIdle';

/** 状态文件名（数据目录根下，与 daemon.pid 同级）。 */
const DAEMON_STATE_FILE = 'daemon-state.json';

const STAY_REASONS: readonly DaemonStayReason[] = ['running-runs', 'armed-schedules', 'paired-companion', 'awaiting-approval'];
const QUIT_INTENTS: readonly DaemonQuitIntent[] = ['none', 'background', 'stop'];

export interface DaemonStateFile {
  /** 写文件的 daemon 进程 pid；与 pid 文件记录不吻合即视为陈旧。 */
  pid: number;
  intent: DaemonQuitIntent;
  reasons: DaemonStayReason[];
  /** 已启用定时任务数（「N armed schedule(s)」文案用）。 */
  armedSchedules: number;
  updatedAt: number;
}

function daemonStatePath(dataDir: string): string {
  return path.join(dataDir, DAEMON_STATE_FILE);
}

/** 原子写（tmp + rename）。失败上抛，由调用方 warn 留痕——观测文件不挡运行。 */
export function writeDaemonStateFile(dataDir: string, state: DaemonStateFile): void {
  const target = daemonStatePath(dataDir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  fs.renameSync(tmp, target);
}

/** 宽容读：文件缺失/解析失败/形状不符一律 null（调用方按「无留守原因」口径处理）。 */
export function readDaemonStateFile(dataDir: string): DaemonStateFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(daemonStatePath(dataDir), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.pid !== 'number' || !Number.isInteger(candidate.pid) || candidate.pid <= 0) return null;
  if (typeof candidate.armedSchedules !== 'number' || !Number.isInteger(candidate.armedSchedules) || candidate.armedSchedules < 0) return null;
  if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) return null;
  if (!QUIT_INTENTS.includes(candidate.intent as DaemonQuitIntent)) return null;
  if (!Array.isArray(candidate.reasons) || candidate.reasons.some((reason) => !STAY_REASONS.includes(reason as DaemonStayReason))) return null;
  return {
    pid: candidate.pid,
    intent: candidate.intent as DaemonQuitIntent,
    reasons: candidate.reasons as DaemonStayReason[],
    armedSchedules: candidate.armedSchedules,
    updatedAt: candidate.updatedAt,
  };
}

const REASON_LABELS: Record<Exclude<DaemonStayReason, 'armed-schedules'>, string> = {
  'running-runs': 'running runs',
  'paired-companion': 'paired companion',
  'awaiting-approval': 'pending approval',
};

/** status 文案（ADR-083 拍板 2026-10-18）：有原因列原因，没原因明说「壳走就退」。 */
export function formatDaemonStayStatus(state: DaemonStateFile | null): string {
  if (state && state.reasons.length > 0) {
    const parts = state.reasons.map((reason) => reason === 'armed-schedules'
      ? `${state.armedSchedules} armed schedule${state.armedSchedules === 1 ? '' : 's'}`
      : REASON_LABELS[reason]);
    return `Staying alive because: ${parts.join(', ')}`;
  }
  return 'No reason to stay alive: exits once the shell is gone';
}
