// ============================================================================
// CloudChannelRun — 通道入站 ↔ 云端 run 账本的生产装配（ADR-087 S4B）
// ============================================================================
// 只在 web 服务模式（agent.ts 以 isWebServiceMode() 把关）调用 wireChannelCloudRun：
// 1) 往 host/channels 注册 ChannelCloudRunPort（admit 走 ledger.admit(trigger
//    channel)，settle 走 runtime.settle，waitForSettled 订阅账本迁移）；
// 2) 返回 executeChannelRun 交给 CloudRunRouteRuntime——提升起的 channel 行
//    从 request_json 还原载荷后经桥的 runAdmittedChannelTurn 执行。
// 桥缺席时抛错，让 startPromotedChannelRun 的 catch settle failed 并留痕。
// ============================================================================

import type { CloudRunLedger } from '../../host/services/cloudRun/cloudRunLedger';
import { isTerminalCloudRunState } from '../../shared/contract/cloudRun';
import type { CloudRunRecord } from '../../host/services/core/repositories/CloudRunRepository';
import { getChannelAgentBridge } from '../../host/channels/channelAgentBridge';
import { decodeChannelCloudRunPayload } from '../../host/channels/channelCloudAdmission';
import { setChannelCloudRunPort } from '../../host/channels/channelCloudRunPort';
import type { WebRouteLogger } from './routeTypes';

/** 与 CloudRunRouteRuntime.settle 同语义：终态行幂等跳过，否则走合同迁移表。 */
function settleLedgerRun(ledger: CloudRunLedger, runId: string, state: 'succeeded' | 'failed'): void {
  const current = ledger.getRun(runId);
  if (!current || isTerminalCloudRunState(current.state)) return;
  ledger.transition(runId, state);
}

/** 订阅账本迁移等一条行收线；先订阅再查现值，终态在两步之间落地也不漏。 */
function waitForChannelRunSettled(ledger: CloudRunLedger, runId: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve();
    };
    unsubscribe = ledger.onTransition((transition) => {
      if (transition.runId === runId && isTerminalCloudRunState(transition.toState)) finish();
    });
    const current = ledger.getRun(runId);
    if (current && isTerminalCloudRunState(current.state)) finish();
  });
}

/**
 * 服务模式装配：注册通道→账本端口，并返回 executeChannelRun。
 * 幂等：重复调用以后一次注册为准。
 */
export function wireChannelCloudRun(input: {
  getLedger: () => CloudRunLedger;
  logger: WebRouteLogger;
}): { executeChannelRun: (record: CloudRunRecord) => Promise<void> } {
  const { getLedger, logger } = input;
  setChannelCloudRunPort({
    admit: ({ sessionId, channelDeliveryId, requestJson }) =>
      getLedger().admit({ sessionId, trigger: 'channel', channelDeliveryId, requestJson }),
    settle: (runId, state) => settleLedgerRun(getLedger(), runId, state),
    waitForSettled: (runId) => waitForChannelRunSettled(getLedger(), runId),
  });
  return {
    executeChannelRun: async (record) => {
      const bridge = getChannelAgentBridge();
      if (!bridge) {
        logger.error('[CloudRun] Promoted channel run has no ChannelAgentBridge; failing', {
          runId: record.runId,
          sessionId: record.sessionId,
        });
        throw new Error('ChannelAgentBridge is not available to execute a promoted channel run');
      }
      const payload = decodeChannelCloudRunPayload(record.requestJson);
      await bridge.runAdmittedChannelTurn(payload, record.runId);
    },
  };
}
