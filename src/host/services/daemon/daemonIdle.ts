// ============================================================================
// Daemon Idle — ADR-083 常驻宿主的空闲去留判据
// ============================================================================
// 拍板记录 2：空闲（无 run、无配对伴侣、无等审批）时 daemon 随壳退出，配对伴侣
// 在线时除外。三个信号由 web 侧（app.ts）供给，前两个与 IdleSleepInhibitor 同源，
// 不另造第二套判据。纯函数：只做判定，不读状态、不计时。
// ============================================================================

export interface DaemonIdleSnapshot {
  /** 有 run 在跑（runRegistry 非空或后台任务台账有活任务）。 */
  runningRuns: boolean;
  /** 有配对伴侣设备在线。 */
  pairedCompanion: boolean;
  /** 有等待用户审批的请求。 */
  awaitingApproval: boolean;
}

/** 三者全空闲才随壳退出；任何一项在忙就留着（返回 false = 留守）。 */
export function shouldDaemonExit(snapshot: DaemonIdleSnapshot): boolean {
  return !snapshot.runningRuns && !snapshot.pairedCompanion && !snapshot.awaitingApproval;
}
