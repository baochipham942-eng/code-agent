// ============================================================================
// Orchestrator Permissions - Permission and approval state
// ============================================================================

import type { AgentEvent, AppSettings, PermissionRequest, PermissionResponse } from '../../shared/contract';
import type { PermissionDeliveryOutcome } from '../../shared/contract/permission';
import type { ToolApprovalPayload, PendingApprovalKind } from '../../shared/contract/pendingApproval';
import { INTERACTION_TIMEOUTS } from '../../shared/constants/timeouts';
import { generatePermissionRequestId } from '../../shared/utils/id';
import type { ExecutionTopology } from '../permissions';
import { getPermissionModeManager } from '../permissions/modes';
import { isUnattendedAllowedReadOnlyTool } from '../permissions/unattendedReadOnlyTools';
import { getSessionAutomationService } from '../services/sessionAutomation/sessionAutomationService';
import { notificationService } from '../services/infra/notificationService';
import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import { isExternalSideEffectTool } from '../tools/externalSideEffect';
import { approvalParkEvents } from './approvalParkEvents';
import { getConfirmationGate } from './confirmationGate';
import { getPermissionLevel } from './orchestrator/modelConfigResolver';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AgentOrchestrator');

/** 归一化审批响应为「放行/拒绝」。allow_standing（B4 铸权）在放行语义上等价 allow。 */
function isApproveResponse(response: PermissionResponse): boolean {
  return response === 'allow' || response === 'allow_session' || response === 'allow_standing';
}

export class OrchestratorPermissionIsland {
  private pendingPermissions: Map<string, {
    resolve: (response: PermissionResponse) => void;
    request: PermissionRequest;
    /** B2: 无人值守停车挂起的审批（有 pending_approvals 行）。resolve 走 repo-changes 裁决口。 */
    parked?: boolean;
  }> = new Map();
  private readonly injectedPendingApprovalRepo?: PendingApprovalRepository;
  private cachedPendingApprovalRepo: PendingApprovalRepository | null = null;

  constructor({
    getSettings,
    getExecutionTopology,
    onEvent,
    injectedPendingApprovalRepo,
  }: {
    getSettings: () => AppSettings;
    getExecutionTopology: () => ExecutionTopology;
    onEvent: (event: AgentEvent) => void;
    injectedPendingApprovalRepo?: PendingApprovalRepository;
  }) {
    this.getSettings = getSettings;
    this.getExecutionTopology = getExecutionTopology;
    this.onEvent = onEvent;
    this.injectedPendingApprovalRepo = injectedPendingApprovalRepo;
  }

  private readonly getSettings: () => AppSettings;
  private readonly getExecutionTopology: () => ExecutionTopology;
  private readonly onEvent: (event: AgentEvent) => void;

  handlePermissionResponse(requestId: string, response: PermissionResponse): PermissionDeliveryOutcome {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      // 这条分支就是「用户点了『允许』，然后什么也没发生」的现场（2026-07-26 真机踩到）：
      // 60s 交互门超时后条目已被删除，迟到的点击落进虚空——**两端都不可见**，
      // 用户只看到「失败」，日志里一个字都没有，无从查起。
      // 任何丢弃分支必须留痕，且要指名道姓说清是谁被丢了。
      logger.warn('Permission response for unknown/expired request, dropped', {
        requestId,
        response,
        knownRequestIds: [...this.pendingPermissions.keys()],
      });
      return 'unknown_request';
    }
    // B2: 停车挂起的审批走 repo-changes 裁决口（会话卡 / 收件箱两口共用）。
    if (pending.parked) {
      logger.info('Permission response delivered to parked approval', { requestId, response, tool: pending.request?.tool });
      this.resolveParkedApproval(requestId, response);
      return 'delivered';
    }
    // 成功路径也要留痕：没有这条就无法区分「点击没到 host」和「到了但没生效」，
    // 2026-07-26 那次排查整整卡在这个区分上。
    logger.info('Permission response delivered', { requestId, response, tool: pending.request?.tool });
    pending.resolve(response);
    this.pendingPermissions.delete(requestId);
    return 'delivered';
  }

  /**
   * B2 first-responder-wins 裁决口。会话内 permissionResponse 和收件箱 resolve 两个入口
   * 都汇入这里：以 pending_approvals 的 UPDATE changes 数为唯一裁决——changes=0 表示
   * 该行已被抢答/过期/orphaned，第二口静默 no-op，绝不二次 resolve 内存 Promise。
   * 内存 Map delete 只在 repo 裁决赢了之后做。
   */
  resolveParkedApproval(
    id: string,
    response: PermissionResponse,
    feedbackOverride?: string,
  ): void {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return;
    const repo = this.getPendingApprovalRepo();
    if (repo) {
      const status = isApproveResponse(response) ? 'approved' : 'rejected';
      let changes: number;
      try {
        changes = repo.resolve({
          id,
          status,
          feedback: feedbackOverride ?? null,
          resolvedAt: Date.now(),
        });
      } catch (err) {
        logger.warn(`Parked approval repo.resolve failed for ${id}`, err);
        // repo 写失败按裁决未赢处理，不动内存 Promise，避免 DB/内存分叉。
        return;
      }
      if (changes === 0) {
        logger.info(`Parked approval ${id} already resolved/expired, ignoring second responder`);
        return;
      }
      approvalParkEvents.emit('resolved', { id, sessionId: pending.request.sessionId ?? null, status });
    }
    // B4 铸权：仅当人工在停车审批卡点「每次都允许发 <target>」（allow_standing）且赢得裁决后，
    // 把 (tool, target) 长期授权规则写到该会话所属 automation。target 从审批请求透传字段取，
    // 模型侧无任何入口（no-self-grant）。铸造失败（automation 不可解析/已归档）不影响本次放行。
    if (response === 'allow_standing') {
      this.mintStandingGrantFromRequest(pending.request);
    }
    this.pendingPermissions.delete(id);
    pending.resolve(response);
  }

  /** B4：从审批请求解析 target 并在其会话所属 automation 上铸造长期授权规则（幂等、fail-safe）。 */
  private mintStandingGrantFromRequest(request: PermissionRequest): void {
    const target = request.details?.standingGrantTarget;
    if (typeof target !== 'string' || !target) {
      logger.warn('allow_standing without a standing-grant target; nothing to mint', { tool: request.tool });
      return;
    }
    try {
      const minted = getSessionAutomationService().mintStandingGrant(
        request.sessionId ?? null,
        request.tool,
        target,
        Date.now(),
      );
      if (!minted) {
        logger.info('Standing grant not minted (no active automation for session)', { tool: request.tool });
      }
    } catch (err) {
      logger.warn('Standing grant mint failed', err);
    }
  }

  /**
   * 解除所有挂起的权限请求。新消息到达 / 取消时调用：挂起的权限 Promise 若一直无人
   * resolve，会把 await 在 requestPermission 上的 agentLoop 冻结到 60s 超时（死锁）。
   * 统一以 'deny' 解除——安全侧默认不放行；模型在被拒后会按指令重新发起调用、重新弹卡。
   *
   * B2 取消收尾：停车挂起的审批必须同步 repo resolve('rejected')，否则取消后 DB 留下
   * 孤儿 pending 行、收件箱永远挂着一条无对应 run 的待批准。
   */
  drainPendingPermissions(response: PermissionResponse = 'deny'): void {
    if (this.pendingPermissions.size === 0) return;
    const count = this.pendingPermissions.size;
    const repo = this.getPendingApprovalRepo();
    for (const [id, entry] of this.pendingPermissions.entries()) {
      if (entry.parked && repo) {
        try {
          const changes = repo.resolve({ id, status: 'rejected', feedback: 'run cancelled', resolvedAt: Date.now() });
          if (changes > 0) {
            approvalParkEvents.emit('resolved', { id, sessionId: entry.request.sessionId ?? null, status: 'rejected' });
          }
        } catch (err) {
          logger.warn(`Parked approval cancel-resolve failed for ${id}`, err);
        }
      }
      entry.resolve(response);
    }
    this.pendingPermissions.clear();
    logger.info(`Drained ${count} pending permission(s)`, { response });
  }

  /** B2: 懒取停车审批持久化仓库。注入优先（测试），否则回退 DB 单例（生产）。 */
  private getPendingApprovalRepo(): PendingApprovalRepository | null {
    if (this.injectedPendingApprovalRepo) return this.injectedPendingApprovalRepo;
    if (this.cachedPendingApprovalRepo) return this.cachedPendingApprovalRepo;
    try {
      const { getDatabase } = require('../services/core/databaseService') as typeof import('../services/core/databaseService');
      this.cachedPendingApprovalRepo = getDatabase().getPendingApprovalRepo();
      return this.cachedPendingApprovalRepo;
    } catch (err) {
      logger.warn('Pending approval repo unavailable, unattended approvals fall back to timeout deny', err);
      return null;
    }
  }

  async requestPermission(request: Omit<PermissionRequest, 'id' | 'timestamp'>): Promise<boolean> {
    const fullRequest: PermissionRequest = {
      ...request,
      id: generatePermissionRequestId(),
      timestamp: Date.now(),
    };

    if (process.env.AUTO_TEST) {
      logger.info(`[AUTO_TEST] Auto-approving permission: ${request.type} for ${request.tool}`);
      return true;
    }

    // 目录访问是信任边界扩权（新增一整个 Project Source），不受 devMode/autoApprove-by-level
    // 影响（那些开关是为读/写/执行类日常操作设的，不该顺带放行扩权决定）；也不论 attended/
    // unattended 一律走 B2 停车挂起——60s 内联对话框对"要不要新增一个目录的访问权"这种
    // 决策窗口太短。repo 不可用时（DB 未就绪/测试）才回退到下面的常规路径。
    if (request.type === 'directory_access') {
      const dirRepo = this.getPendingApprovalRepo();
      if (!dirRepo) {
        // fail-closed：扩权的失败方向不能是放行。回落常规路径的话，devModeAutoApprove
        // 会把「新增一个目录的访问权」顺带自动批了——那正是上面这段要挡住的事。
        logger.warn('[Permission] 停车台账不可用，directory_access 扩权请求按 fail-closed 拒绝');
        return false;
      }
      return this.parkApproval(fullRequest, getPermissionLevel(request.type), dirRepo, 'directory_access');
    }

    const settings = this.getSettings();
    const permissionLevel = getPermissionLevel(request.type);
    const forceConfirm = request.forceConfirm === true;

    if (!forceConfirm && settings.permissions.devModeAutoApprove) {
      logger.info(`[DevMode] Auto-approving permission: ${request.type} for ${request.tool}`);
      return true;
    }

    if (!forceConfirm && settings.permissions.autoApprove[permissionLevel]) {
      return true;
    }

    // 无人值守（async_agent）会话：连接器显式声明为只读的 MCP 工具免交互审批直接放行。
    // 否则读飞书日历/表格会撞下面的 60s 交互门、无人应答被 deny，无人值守 cron 永远跑不完
    // （真机 dogfood 2026-07-24 实证）。判据是我方 catalog 声明，不信第三方 server 自报。
    if (
      !forceConfirm
      && this.getExecutionTopology() === 'async_agent'
      && isUnattendedAllowedReadOnlyTool(request.tool)
    ) {
      logger.info(`[Unattended] Auto-approving declared read-only MCP tool: ${request.tool}`);
      return true;
    }

    // 无人值守会话（cron/heartbeat/channel）：审批不再走 60s deny，改为「停车挂起」，
    // 写 pending_approvals 等收件箱/会话卡任一入口应答（B2）。判据与权限档钳制同源
    // （markUnattendedSession）。repo 不可用时（DB 未就绪/测试）回退老 60s 路径。
    //
    // 语音派的 run 走同一条路（2026-07-26 真机）：D4 抬严的立论就是「用户在通话里
    // 手不在键盘上、眼睛不在 diff 上，这姿态等于无人值守」——既然这么判定，审批就不能
    // 要求他 60 秒内点一下。实测通话结束后 run 才请求审批，60s 必然超时自动拒绝，
    // 而迟到的点击又落进静默丢弃分支，用户只看到「失败」且毫无线索。
    // 判据与抬严同源（isLiveVoiceSession = 通话中 或 语音派的 run 还在飞）。
    const needsParking = getPermissionModeManager().isUnattendedSession(fullRequest.sessionId)
      || getPermissionModeManager().isLiveVoiceSession(fullRequest.sessionId);
    const parkRepo = needsParking ? this.getPendingApprovalRepo() : null;
    if (parkRepo) {
      return this.parkApproval(fullRequest, permissionLevel, parkRepo);
    }

    const PERMISSION_TIMEOUT = 60000;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingPermissions.delete(fullRequest.id);
        logger.warn(`Timeout for ${request.type} on ${request.tool}, denying`);
        resolve(false);
      }, PERMISSION_TIMEOUT);

      this.pendingPermissions.set(fullRequest.id, {
        resolve: (response) => {
          clearTimeout(timeoutId);
          if (response === 'allow_session' && fullRequest.sessionId) {
            getConfirmationGate().recordApproval(fullRequest.sessionId, fullRequest.tool);
          }
          resolve(isApproveResponse(response));
        },
        request: fullRequest,
      });
      this.onEvent({ type: 'permission_request', data: fullRequest });
    });
  }

  /**
   * B2 停车挂起：无人值守会话的审批请求写入 pending_approvals，内存仍登记 Promise 但
   * 不设 60s 超时（改 24h 兜底防泄漏）。批准/拒绝走 resolveParkedApproval 裁决口。
   */
  private parkApproval(
    fullRequest: PermissionRequest,
    permissionLevel: string,
    repo: PendingApprovalRepository,
    kind: PendingApprovalKind = 'tool_approval',
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        logger.warn(`Parked approval ${fullRequest.id} expired after 24h backstop, denying`);
        this.resolveParkedApproval(fullRequest.id, 'deny', 'parked approval expired');
      }, INTERACTION_TIMEOUTS.PARKED_APPROVAL);

      this.pendingPermissions.set(fullRequest.id, {
        parked: true,
        resolve: (response) => {
          clearTimeout(timeoutId);
          if (response === 'allow_session' && fullRequest.sessionId) {
            getConfirmationGate().recordApproval(fullRequest.sessionId, fullRequest.tool);
          }
          resolve(isApproveResponse(response));
        },
        request: fullRequest,
      });

      const isDirectoryAccess = kind === 'directory_access';
      const payload: ToolApprovalPayload = {
        sessionId: fullRequest.sessionId ?? null,
        tool: fullRequest.tool,
        type: fullRequest.type,
        permissionLevel,
        requestedAt: fullRequest.timestamp,
        argsSummary: fullRequest.details?.command
          ?? fullRequest.details?.path
          ?? fullRequest.details?.filePath
          ?? fullRequest.details?.url,
        // 目录授权卡直接给人话："访问 <path>（只读/读写）· <agent 理由>"，不用通用 tool 名。
        displayTool: isDirectoryAccess
          ? `目录访问：${fullRequest.details?.path ?? '(unknown path)'}（${
              fullRequest.details?.requestedAccess === 'read_write' ? '读写' : '只读'
            }）${fullRequest.reason ? `· ${fullRequest.reason}` : ''}`
          : undefined,
        riskClass: isExternalSideEffectTool(fullRequest.tool) ? 'external' : null,
        // B4：external+可提取 target 时非空 → 收件箱审批卡出「每次都允许发 <target>」铸权入口。
        standingGrantTarget: fullRequest.details?.standingGrantTarget ?? null,
      };
      try {
        repo.insert({
          id: fullRequest.id,
          kind,
          agentId: null,
          agentName: null,
          coordinatorId: fullRequest.sessionId ?? null,
          payload,
          submittedAt: fullRequest.timestamp,
        });
      } catch (err) {
        logger.warn(`Parked approval persist failed for ${fullRequest.id}`, err);
      }

      if (fullRequest.sessionId) {
        try {
          notificationService.notifyNeedsInput({
            sessionId: fullRequest.sessionId,
            title: '有操作等你批准',
            body: `无人值守任务请求执行 ${fullRequest.tool}，已挂起等待你在收件箱确认。`,
          });
        } catch (err) {
          logger.warn('Parked approval notification failed', err);
        }
      }
      approvalParkEvents.emit('parked', {
        id: fullRequest.id,
        sessionId: fullRequest.sessionId ?? null,
        tool: fullRequest.tool,
        riskClass: payload.riskClass,
      });

      this.onEvent({ type: 'permission_request', data: fullRequest });
    });
  }
}
