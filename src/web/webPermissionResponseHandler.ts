// ============================================================================
// 审批响应投递（web 路径）——从 webServer.ts 原地抽出（该文件已到 god-file 上限）
// ============================================================================
//
// 2026-07-26 真机：点「允许」点不动，打接口稳定返回 `{"error":"Agent not initialized"}`
// 且**全链路零日志**。真因不是 TaskManager 拿错实例，而是这里原本把请求转发给
// `agent.ipc.ts` 的 legacy handler，而 webServer 传给它的 `getAppService: () => null`
// （webServer.ts 里明写着 "Web mode uses HTTP API, not AppService"）——
// **发行版跑的就是 web 路径，所以这条投递链在生产上从来没通过**。
// 同族前科见 webServer.ts 步骤 5~9 的 web/main 路径分离修复。
//
// 修法：不再经过 AppService，直接投给 TaskManager 单例（web 路径在 createAgentRuntime
// 里已经初始化过它），并且每一个出口都指名道姓留痕 + 回报 outcome，绝不静默 200。

import { IPC_CHANNELS } from '../shared/ipc';
import { getTaskManager } from '../host/task/TaskManager';
import { closeDeadParkedApproval } from '../host/agent/parkedApprovalHydration';
import type { PermissionDeliveryOutcome, PermissionResponse } from '../shared/contract/permission';
import type { PendingDevPermissionRequest } from './routes/dev';
import type { WebRouteLogger } from './routes/routeTypes';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;

interface PermissionResponseDeps {
  handlers: Map<string, IpcHandler>;
  pendingDevPermissions: Map<string, PendingDevPermissionRequest>;
  getCurrentSessionId: () => string | null;
  logger: Pick<WebRouteLogger, 'info' | 'warn'>;
}

/** outcome → HTTP 错误码。delivered 不在此表内。 */
const FAILURE_CODES: Record<Exclude<PermissionDeliveryOutcome, 'delivered'>, string> = {
  unknown_request: 'PENDING_PERMISSION_NOT_FOUND',
  no_orchestrator: 'NO_ACTIVE_ORCHESTRATOR',
  no_session: 'NO_ACTIVE_SESSION',
};

export function installPermissionResponseHandler(deps: PermissionResponseDeps): void {
  const { handlers, pendingDevPermissions, getCurrentSessionId, logger } = deps;

  handlers.set(
    IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
    async (_event: unknown, ...args: unknown[]) => {
      const [requestId, response, sessionId] = args as [string, PermissionResponse, string | undefined];
      const pending = pendingDevPermissions.get(requestId);
      if (pending) {
        logger.info('Permission response delivered (web-dev pending)', { requestId, response });
        pending.resolve(response);
        return {
          success: true,
          data: {
            requestId,
            sessionId: sessionId || pending.request.sessionId,
            source: 'web-dev-real-approval',
          },
        };
      }

      const targetSessionId = sessionId || getCurrentSessionId();
      const outcome: PermissionDeliveryOutcome = targetSessionId
        ? getTaskManager().handlePermissionResponse(targetSessionId, requestId, response)
        : 'no_session';

      if (outcome === 'delivered') {
        logger.info('Permission response delivered (web)', { requestId, response, sessionId: targetSessionId });
        return { success: true, data: { requestId, sessionId: targetSessionId, source: 'task-manager' } };
      }

      // 停车审批的宿主已随进程重启消失：fail-closed 拒绝并从待办收口。
      if (closeDeadParkedApproval(requestId)) {
        logger.warn('Parked approval rejected on dead resolve (web)', { requestId, outcome });
        return {
          success: true,
          data: { requestId, sessionId: targetSessionId, outcome, closed: true },
        };
      }
      logger.warn('Permission response not delivered (web)', {
        requestId,
        response,
        sessionId: targetSessionId,
        outcome,
      });
      return {
        success: false,
        error: {
          code: FAILURE_CODES[outcome],
          message: `Permission response for ${requestId} not delivered (${outcome}, session=${targetSessionId ?? 'none'})`,
        },
      };
    },
  );
}
