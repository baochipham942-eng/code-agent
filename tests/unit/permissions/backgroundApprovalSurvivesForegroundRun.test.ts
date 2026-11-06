// N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO — host 侧契约（To do 2）
//
// 症状追问：前台 run 结束时，宿主会不会把后台任务（delegate_task / spawn_agent
// run_in_background lane）挂着的审批一起收掉？如果会，那是渲染层之外的第二个根因。
//
// 事实链（grep 为证，见证据档）：
// - 审批的 pending Promise 全部挂在会话 OrchestratorPermissionIsland.pendingPermissions
//   （src/host/agent/orchestratorPermissions.ts），后台 lane 的请求经
//   subagentToolRuntime.requestPermission → canUseTool → legacyCtx.requestPermission
//   落进同一个 island，且带着自己的 { agentId, runId } 身份。
// - drainPendingPermissions 只有两处调用：executeMessage（新用户消息到达，
//   agentOrchestrator.ts:209）与 cancel（agentOrchestrator.ts:323）。前台 run 正常收线
//   （runFinalizer.finalizeRun）只发 agent_complete 事件，不碰 island。
// - 所以「前台 run 结束」对 island 是无操作：后台审批保持 pending；此后任一时刻的
//   handlePermissionResponse 都能送达并唤醒后台 lane。
//
// 本文件把这条契约钉在 island 层：前台 run 结束（时间推进越过一切看门狗）后，
// 后台 lane 的审批仍 pending；approve → 后台任务继续；deny → 后台任务收到拒绝。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings, PermissionAskResult } from '../../../src/shared/contract';

const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => logSpies),
  logger: logSpies,
  default: logSpies,
}));

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  },
} as unknown as AppSettings);

function isStillPending(promise: Promise<PermissionAskResult>): Promise<boolean> {
  const marker = Symbol('pending');
  return Promise.race([promise, Promise.resolve(marker)]).then((result) => result === marker);
}

/**
 * 后台 lane（spawn_agent run_in_background）发起的审批：请求带 lane 身份
 * agentId/runId（subagentToolRuntime.requestPermission 把 identity 摊进请求），
 * bash 类 ask+forceConfirm（后台子代理标 async_agent 的既有口径）。
 */
function beginBackgroundLaneApproval() {
  const events: AgentEvent[] = [];
  const island = new OrchestratorPermissionIsland({
    getSettings: settings,
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'async_agent',
    hasApprovalUi: () => true,
    onEvent: (event) => events.push(event),
  });
  const promise = island.requestPermission({
    type: 'command',
    tool: 'bash',
    details: { command: 'mkdir -p ~/outside-workspace' },
    sessionId: 'bg-card-session',
    agentId: 'bg-agent-1',
    runId: 'bg-run-1',
    forceConfirm: true,
  });
  const [request] = island.listPendingRequests();
  if (!request) throw new Error('permission request was not registered');
  return { island, promise, request, events };
}

describe('前台 run 结束后，后台 lane 的审批在宿主仍 pending（N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPermissionModeManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPermissionModeManager();
  });

  it('前台 run 收线（island 不被触碰）后审批仍 pending，lane 身份随事件下发', async () => {
    const { island, promise, request, events } = beginBackgroundLaneApproval();

    // 宿主在前台 run 正常收线时对 island 无任何调用；把时钟推过一切看门狗/提醒档，
    // 证明没有任何超时会替用户裁决这条后台审批。
    await vi.advanceTimersByTimeAsync(31 * 60_000);

    expect(await isStillPending(promise)).toBe(true);
    const stillListed = island.listPendingRequests().find((entry) => entry.id === request.id);
    expect(stillListed).toBeDefined();
    // lane 身份原样透传：渲染层靠它区分「后台任务的卡」与前台请求。
    expect(stillListed?.agentId).toBe('bg-agent-1');
    expect(stillListed?.runId).toBe('bg-run-1');
    const raised = events.find((event) => event.type === 'permission_request');
    expect(raised).toBeDefined();
  });

  it('迟到的批准送达宿主，后台任务的审批 Promise 以放行收尾（后台任务继续）', async () => {
    const { island, promise, request } = beginBackgroundLaneApproval();

    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(await isStillPending(promise)).toBe(true);

    const outcome = island.handlePermissionResponse(request.id, 'allow');
    expect(outcome).toBe('delivered');

    const result = await promise;
    expect(result.approved).toBe(true);
  });

  it('拒绝送达后后台任务收到拒绝、审批 Promise 以拒绝收尾（后台任务停在这一步）', async () => {
    const { island, promise, request } = beginBackgroundLaneApproval();

    const outcome = island.handlePermissionResponse(request.id, 'deny');
    expect(outcome).toBe('delivered');

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.denialSource).toBe('user');
    expect(island.listPendingRequests()).toHaveLength(0);
  });
});
