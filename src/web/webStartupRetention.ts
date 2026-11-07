// ============================================================================
// 启动期保留清理（日志 + 数据库 + 缓存 + 录音）—— 发行版路径接线
//
// logRetention / dbRetention 原本只在 Electron main 路径（app/bootstrap.ts:130/:138）
// 启动，而所有发行版跑的是 src/web/webServer.ts —— 于是这两个"修死代码"的修复自己成了
// 死代码：dbRetention 头注释自陈生产库因 telemetry 表无 TTL 涨到 377MB+
// （telemetry_events 62 万行占 163MB），发行版从未清理过。
//
// 单独成文件而非内联进 webServer：webServer 已在 max-lines(1000, skipComments) 边缘，
// 与 webCapabilityBootstrap.ts / queuedInputStartupSweep.ts 同一手法。
// ============================================================================

import { createLogger } from '../host/services/infra/logger';
import { setIntegrityCheckListener } from '../host/services/core/database/integrityGate';
import { setLedgerCorruptionListener } from '../host/services/core/database/ledgerCorruptionMonitor';
import { markPersistenceDegraded } from './helpers/sessionCache';
import { SQLITE_INTEGRITY } from '../shared/constants';

const logger = createLogger('WebStartupRetention');

/**
 * fire-and-forget 触发各项保留清理。均 best-effort，失败只 warn，不拖死启动：
 * 各项的重活都有界——重数据库操作移出本进程、sqlite 调用与条目数解耦（分块批量）。
 *
 * ⚠️ 这里的「不 await」**不是**防阻塞手段（2026-07-31 事故推翻了原注释的假设）：
 * better-sqlite3 是同步 API，在本进程 `exec('VACUUM')` 会阻塞整个 event loop，
 * 实测把 listen 堵死 59.3 秒 —— 不 await 只避开了 await 语义，避不开同步阻塞。
 * 真正的防阻塞在各清理内部：dbRetention 的全库 VACUUM 已移出本进程
 * （dbVacuumSubprocess.ts）；音频清扫的 wav_path 指针清空按块批量合并
 * （audioRetention.clearPointers），sqlite3 子进程数不随过期行数线性涨
 * （PR #2820 review：逐行 spawn 曾把采集关闭数月机器的首启卡在 listen 前）。
 */
export function kickoffStartupRetention(): void {
  setIntegrityCheckListener((result) => {
    if (!result.ok) markPersistenceDegraded(SQLITE_INTEGRITY.QUICK_CHECK_FAILED);
  });
  setLedgerCorruptionListener((signal) => {
    markPersistenceDegraded(signal.reason);
  });
  void import('../host/services/infra/logRetention')
    .then(({ runLogRetention }) => runLogRetention())
    .catch((error) => logger.warn('Log retention failed (non-blocking):', (error as Error).message));
  void import('../host/services/infra/dbRetention')
    .then(({ runDbRetention }) => runDbRetention())
    .catch((error) => logger.warn('DB retention failed (non-blocking):', (error as Error).message));
  // pptx 逐页预览缓存：启动扫一次 + 每天一次（模块内自带 setInterval，unref 不拖住进程）
  void import('../host/services/infra/presentationPreviewRetention')
    .then(({ kickoffPresentationPreviewRetention }) => kickoffPresentationPreviewRetention())
    .catch((error) => logger.warn('Presentation preview retention failed (non-blocking):', (error as Error).message));
  // app 自有缓存（channel-media / 托管浏览器截图 / appshots）：同款启动 + 每天一次
  void import('../host/services/infra/appCacheRetention')
    .then(({ kickoffAppCacheRetention }) => kickoffAppCacheRetention())
    .catch((error) => logger.warn('App cache retention failed (non-blocking):', (error as Error).message));
  // 录音保留：清扫原本只挂在采集启动/定时器上，采集关着的机器永远不清，
  // 过期 wav 无限堆积。启动扫一次，与采集开关解耦；失败沿用既有记账
  // （logger.warn + retention ledger → 设置页 AudioRetentionFailureLine）。
  // 开销有界：指针清空在清扫内部按块批量（sqlite3 调用数与过期行数无关），
  // 其余是内存中的 fs 遍历/unlink，均 µs 级/文件。
  void import('../host/services/desktop/desktopAudioCapture')
    .then(({ sweepCapturedAudio }) => sweepCapturedAudio())
    .catch((error) => logger.warn('Audio retention failed (non-blocking):', (error as Error).message));
}
