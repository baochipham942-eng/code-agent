// ============================================================================
// Daemon Idle — ADR-083 常驻宿主的空闲去留判据
// ============================================================================
// 拍板记录 2：空闲（无 run、无配对伴侣、无等审批）时 daemon 随壳退出，配对伴侣
// 在线时除外。三个信号由 web 侧（app.ts）供给，前两个与 IdleSleepInhibitor 同源，
// 不另造第二套判据。纯函数：只做判定，不读状态、不计时。
//
// 2026-10-18 append（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON）：快照新增第四信号
// armedSchedules（已启用定时任务数，与退出确认弹窗的 quit-guard 计数同源）。
// 它单独永不留守——只有壳声明了「后台继续」（intent=background）才构成留守
// 原因；壳崩了/被杀（intent=none）不留隐形 daemon（拍板记录 2 不被推翻）。
// ============================================================================

/** 壳声明的退出意图；真源状态在 quitIntent.ts，这里只放类型供纯判据引用。 */
export type DaemonQuitIntent = 'none' | 'background' | 'stop';

export interface DaemonIdleSnapshot {
  /** 有 run 在跑（runRegistry 非空或后台任务台账有活任务）。 */
  runningRuns: boolean;
  /** 有配对伴侣设备在线。 */
  pairedCompanion: boolean;
  /** 有等待用户审批的请求。 */
  awaitingApproval: boolean;
  /** 已启用定时任务数（与 quit-guard 计数同源）。缺省按 0：老快照/老调用方不带。 */
  armedSchedules?: number;
}

/** 留守原因（去留判定与 `neo daemon status` 的状态文件共用一源）。 */
export type DaemonStayReason = 'running-runs' | 'armed-schedules' | 'paired-companion' | 'awaiting-approval';

/** 三者全空闲才随壳退出；任何一项在忙就留着（返回 false = 留守）。 */
export function shouldDaemonExit(snapshot: DaemonIdleSnapshot): boolean {
  return !snapshot.runningRuns && !snapshot.pairedCompanion && !snapshot.awaitingApproval;
}

/** 留守原因清单（纯判据，2026-10-18 append）：老三信号任一在忙，或
 * （intent=background 且 armedSchedules>0）。空清单 = 不留守。
 * intent=stop 不在这里出现：它把 stdin EOF 变成停机指令（stdinEofIsQuitCommand），
 * 不是留守原因。armedSchedules 缺省按 0（老快照）。 */
export function daemonStayReasons(snapshot: DaemonIdleSnapshot, intent: DaemonQuitIntent): DaemonStayReason[] {
  const reasons: DaemonStayReason[] = [];
  if (snapshot.runningRuns) reasons.push('running-runs');
  if (snapshot.pairedCompanion) reasons.push('paired-companion');
  if (snapshot.awaitingApproval) reasons.push('awaiting-approval');
  if (intent === 'background' && (snapshot.armedSchedules ?? 0) > 0) reasons.push('armed-schedules');
  return reasons;
}
