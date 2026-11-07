// webServer 启动期的两个收口：放在这里让 webServer.ts 不再加行（它的有效行顶着 max-lines 上限）。
type WarnLogger = { info(message: string): void; warn(message: string, detail?: unknown): void };

export async function runStartupSweeps(logger: WarnLogger): Promise<void> {
  // Loop 启动收口（N-LOOP-DURABLE 刀1 + 修复棒）：归属进程已确认消失的 loop 残留
  // 在 session_automations 里永远停在 running，侧栏徽标继续谎报「运行中」。
  // 在 renderer 连上来之前把残留收成终态并发一条人话通知（判据 = loopOwnership
  // 进程归属戳，别的进程还在跑的不动）；只收口，不恢复续跑。
  try {
    const { markInterruptedLoops } = await import('../host/loop/loopStartupRecovery');
    const lost = await markInterruptedLoops();
    if (lost > 0) logger.info(`Loop startup recovery: ${lost} interrupted loop(s) marked as lost`);
  } catch (error) {
    logger.warn('Loop startup recovery failed (non-blocking):', (error as Error).message);
  }
  // 指挥台任务重启中断收口：上个进程运行中遗留的任务补一条失败消息（只补一次，标记随即删除）。
  try {
    const { recoverInterruptedSessionCommandTasks } = await import('../host/services/commandCenter/sessionCommandTaskRestartRecovery');
    const n = await recoverInterruptedSessionCommandTasks();
    if (n > 0) logger.info(`Session command restart recovery: ${n} interrupted task(s) reported`);
  } catch (error) {
    logger.warn('Session command restart recovery failed (non-blocking):', (error as Error).message);
  }
  // 孤儿任务夹清扫（N-DELEGATE-WORKDIR-LAZY-FU1-FU1-FU2）：挂死的子代理 run 加上进程重启后
  // createdByThisProcess 失忆，默认工作根里只剩 .code-agent 的夹子永远没人回收。
  // 不 await 清扫本身，不阻塞 listen；失败只 warn。
  try {
    const { sweepOrphanMetadataOnlyWorkDirectories } = await import('../host/agent/runtime/workDirectoryMaterializer');
    void sweepOrphanMetadataOnlyWorkDirectories().catch((error: Error) => {
      logger.warn('Work directory orphan sweep failed (non-blocking):', error.message);
    });
  } catch (error) {
    logger.warn('Work directory orphan sweep failed (non-blocking):', (error as Error).message);
  }
}
