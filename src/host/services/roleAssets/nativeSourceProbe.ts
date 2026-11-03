// ============================================================================
// 醒来前探测「已启用但未检查」的 native 连接器
// ============================================================================
//
// native 连接器的 readiness 是模块变量，重启后回到 unchecked，只有 probe_access 才会
// 转 ready；能力中心据此把「已启用且已授权」的日历判成 lazy，首次醒来 / 每日醒来就
// 落到「无已连接源」。这里在判据之前补一次 probe_access（与 listMailSources /
// cronMailPoller 同款），只碰 unchecked：failed / unavailable / ready 一律不重探。
// 单次探测的耗时上限沿用 osascript 的 AppleScript 调用上限，不另设超时。
// ============================================================================

import { createLogger } from '../infra/logger';
import { NATIVE_CONNECTOR_IDS } from '../../../shared/constants';

const logger = createLogger('NativeSourceProbe');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 探测所有 unchecked 的已注册 native 连接器；永不抛错，缺席原因逐项落日志。 */
export async function probeUncheckedNativeConnectors(): Promise<void> {
  try {
    const { getConnectorRegistry } = await import('../../connectors');
    const registered = new Map(getConnectorRegistry().list().map((connector) => [connector.id, connector]));
    const notEnabled: string[] = [];
    const unavailable: string[] = [];
    const probeTargets: Array<{ id: string; execute: () => Promise<unknown> }> = [];

    for (const id of NATIVE_CONNECTOR_IDS) {
      const connector = registered.get(id);
      if (!connector) {
        notEnabled.push(id);
        continue;
      }
      const readiness = connector.getCachedStatus?.().readiness;
      if (readiness === 'unavailable') unavailable.push(id);
      else if (readiness === 'unchecked') {
        probeTargets.push({ id, execute: () => connector.execute('probe_access', {}) });
      }
    }

    const probeFailed: string[] = [];
    await Promise.allSettled(probeTargets.map(async (target) => {
      try {
        await target.execute();
      } catch (error) {
        probeFailed.push(target.id);
        logger.warn(`Native connector probe failed (connector: ${target.id}): ${errorMessage(error)}`);
      }
    }));

    if (notEnabled.length > 0 || unavailable.length > 0 || probeFailed.length > 0) {
      logger.info(
        `Native connectors not counted as sources — not enabled: [${notEnabled.join(', ')}]; `
        + `probe-failed: [${probeFailed.join(', ')}]; unavailable: [${unavailable.join(', ')}]`,
      );
    }
  } catch (error) {
    logger.warn(`Native connector pre-probe aborted: ${errorMessage(error)}`);
  }
}
