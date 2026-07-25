// ============================================================================
// 启动期保留清理（日志 + 数据库）—— 发行版路径接线
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

const logger = createLogger('WebStartupRetention');

/**
 * fire-and-forget 触发两项保留清理。
 * 不 await：dbRetention 的 VACUUM 会阻塞，不能进启动关键路径；两者均 best-effort，
 * 失败只 warn，绝不影响启动。
 */
export function kickoffStartupRetention(): void {
  void import('../host/services/infra/logRetention')
    .then(({ runLogRetention }) => runLogRetention())
    .catch((error) => logger.warn('Log retention failed (non-blocking):', (error as Error).message));
  void import('../host/services/infra/dbRetention')
    .then(({ runDbRetention }) => runDbRetention())
    .catch((error) => logger.warn('DB retention failed (non-blocking):', (error as Error).message));
}
