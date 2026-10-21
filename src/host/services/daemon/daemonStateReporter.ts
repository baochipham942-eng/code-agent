// ============================================================================
// Daemon State Reporter — daemon 侧的留守状态文件写入器（ADR-083 append 2026-10-18）
// ============================================================================
// 把「为什么还活着」落到 daemon.pid 旁的 daemon-state.json（原子写），供
// `neo daemon status` 读取。触发面：
//   - start() 时写一次初值；
//   - 意图变化（quit-intent 路由 → onDaemonQuitIntentChange）；
//   - cron 任务增删改/启停（CronService.onJobsChanged，同时联动去留 recheck）；
//   - webServer 把 run/审批/后台任务三类 idle 信号接到 report()（见 webServer 接线）。
// 写失败只 warn 不抛：观测文件永远不挡运行。内容去重（pid/intent/reasons/armed
// 不变就跳过写盘），updatedAt 只在真实变化时前进。
// ============================================================================

import { createLogger } from '../infra/logger';
import { daemonStayReasons, type DaemonIdleSnapshot } from './daemonIdle';
import { writeDaemonStateFile } from './daemonStateFile';
import { getDaemonQuitIntent, onDaemonQuitIntentChange } from './quitIntent';

const logger = createLogger('DaemonState');

export interface DaemonResidencyReport {
  /** 按当前快照/意图重写状态文件（内容未变时跳过）。 */
  report: () => void;
}

export function createDaemonResidencyReporter(input: {
  dataDir: string;
  getSnapshot: () => DaemonIdleSnapshot | undefined;
  /** cron 任务变化时的去留重查（webServer 传入 rechecker.recheck）。 */
  recheck: () => boolean;
}): DaemonResidencyReport {
  const { dataDir, getSnapshot, recheck } = input;
  let lastWrittenKey = '';

  const report = (): void => {
    const snapshot = getSnapshot();
    if (snapshot === undefined) return; // app 未接线：没有可信快照，不写文件
    const intent = getDaemonQuitIntent();
    const reasons = daemonStayReasons(snapshot, intent);
    const key = JSON.stringify({ pid: process.pid, intent, reasons, armed: snapshot.armedSchedules ?? 0 });
    if (key === lastWrittenKey) return;
    try {
      writeDaemonStateFile(dataDir, {
        pid: process.pid,
        intent,
        reasons,
        armedSchedules: snapshot.armedSchedules ?? 0,
        updatedAt: Date.now(),
      });
      lastWrittenKey = key;
    } catch (error) {
      logger.warn('daemon state file write failed', error);
    }
  };

  onDaemonQuitIntentChange(report);
  void (async () => {
    try {
      const { getCronService } = await import('../../cron/cronService');
      getCronService().onJobsChanged(() => {
        report();
        recheck();
      });
    } catch (error) {
      logger.warn('daemon cron-change subscription failed', error);
    }
  })();
  report();

  return { report };
}
