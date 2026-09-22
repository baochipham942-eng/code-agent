// ============================================================================
// 低分自动入候选的真机接线与调度（N-EVAL-FAILURE-AUTOHARVEST）
// ----------------------------------------------------------------------------
// postLaunchAutoHarvest.ts 只认注入的 deps，单测不碰真机。本模块是唯一把它接到
// 真 DB / 真开关 / 真扫描上的地方，并挂调度器：webServer 启动步 7 同款
// try/catch 动态 import、非阻塞；启动时检查一次 + 每 24h 滚动一次，按本地日节流。
// 默认关（privacy.postLaunchAutoHarvest 缺省 false）——关着时每 tick 只 warn 一句就返回。
// ============================================================================
import { POST_LAUNCH_DEFAULTS } from '../../../shared/contract/postLaunchScore';
import { getDatabase } from '../../services/core/databaseService';
import { createLogger } from '../../services/infra/logger';
import { isPostLaunchAutoHarvestEnabled } from './postLaunchGate';
import { maybeRunPostLaunchAutoHarvest, type PostLaunchAutoHarvestDeps } from './postLaunchAutoHarvest';
import { createPostLaunchScorerDeps } from './postLaunchScorerRuntime';
import { runPostLaunchScoring } from './postLaunchScorer';

const logger = createLogger('PostLaunchAutoHarvest');

let autoHarvestTimer: ReturnType<typeof setInterval> | null = null;

function createAutoHarvestDeps(): PostLaunchAutoHarvestDeps | null {
  const db = getDatabase().getDb();
  if (!db) {
    logger.warn('低分自动入候选：数据库尚未就绪，本次扫描跳过');
    return null;
  }
  return {
    db,
    isEnabled: isPostLaunchAutoHarvestEnabled,
    // signalOnly：永不调 judge，零成本零正文外发；扫描锁与 FB-233 补评语义由 scorer 内部保证。
    runScan: () => runPostLaunchScoring(createPostLaunchScorerDeps(), { signalOnly: true }),
    now: () => Date.now(),
    onWarn: (message, error) => logger.warn(message, error),
  };
}

async function tick(): Promise<void> {
  const deps = createAutoHarvestDeps();
  if (!deps) return;
  const outcome = await maybeRunPostLaunchAutoHarvest(deps);
  if (outcome === 'scanned') logger.info('低分自动入候选扫描完成');
}

/** 启动调度器（幂等）。定时器 unref：不挡宿主进程退出。 */
export function startPostLaunchAutoHarvestScheduler(): void {
  if (autoHarvestTimer) return;
  void tick().catch((error: unknown) => logger.warn('低分自动入候选首次扫描异常', error));
  autoHarvestTimer = setInterval(() => {
    void tick().catch((error: unknown) => logger.warn('低分自动入候选定时扫描异常', error));
  }, POST_LAUNCH_DEFAULTS.autoHarvestIntervalMs);
  autoHarvestTimer.unref?.();
}
