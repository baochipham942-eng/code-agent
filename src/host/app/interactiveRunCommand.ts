// ============================================================================
// InteractiveRunCommand — 用户点击 `!run` 按钮的 host 侧执行入口
// ============================================================================
// 语义（业主已拍板，不再开）：
// - 点击后命令走**真 ToolExecutor Bash 管道**：硬毙清单（validateCommand critical）、
//   命令分类器、路径策略与 OS 沙箱跟模型发起的 Bash 调用完全同一条路，不开第二套
//   权限路径；
// - 任何档位（含 bypassPermissions / devModeAutoApprove）都必须真人确认；
// - 输出只回给调用方，不落库、不进会话历史。
//
// 强制确认的缝（toolExecutor.ts 零改动）：
// 1. 构造开 `forcePermissionHandler: true` —— 分类器 approve / 安全命令白名单 /
//    exec-policy allow / skill 预授权的自动放行全部让路，一律进 requestPermission；
// 2. requestPermission 包装器给请求盖 `forceConfirm: true` 后委托会话 orchestrator 的
//    `requestExternalEnginePermission`（同一 permission_request 事件、同一
//    permissionResponse IPC；devModeAutoApprove / autoApprove-by-level 对 forceConfirm
//    让路，见 orchestratorPermissions.ts）。包装器同时丢弃审批应答里的 updatedArgs：
//    执行的命令必须就是点击的 payload，审批卡改参在这条路上不可达。
// ============================================================================

import { getTaskManager } from '../task/TaskManager';
import { ToolExecutor } from '../tools/toolExecutor';
import type { PermissionRequestData, ToolExecutionResult } from '../tools/types';
import { AgentFailureCode } from '../../shared/contract';
import { HostReasonCode, type PermissionAskResult, type PermissionRequest } from '../../shared/contract/permission';

interface InteractiveRunCommandInput {
  sessionId: string;
  command: string;
}

type InteractiveRunCommandStatus = 'completed' | 'refused' | 'denied' | 'failed';

interface InteractiveRunCommandResult {
  status: InteractiveRunCommandStatus;
  output: string;
  exitCode?: number;
  reason?: string;
}

/**
 * 审批被人这一侧否掉（真人拒绝 / 超时无应答 / 无审批面 fail-closed / 运行取消）
 * → `denied`；其余 permission 拒绝都是机器按策略拒的 → `refused`。
 */
const HUMAN_DENIAL_HOST_REASONS: ReadonlySet<HostReasonCode> = new Set([
  HostReasonCode.PermissionDeniedByUser,
  HostReasonCode.PermissionDeniedTimeout,
  HostReasonCode.PermissionDeniedNoApprovalUi,
  HostReasonCode.PermissionDeniedCancelled,
]);

function hostReasonCode(result: ToolExecutionResult): HostReasonCode | undefined {
  const hostReason = result.metadata?.hostReason;
  if (!hostReason || typeof hostReason !== 'object') return undefined;
  const code = (hostReason as { code?: unknown }).code;
  return typeof code === 'string' ? code as HostReasonCode : undefined;
}

function metadataNumber(result: ToolExecutionResult, key: string): number | undefined {
  const value = result.metadata?.[key];
  return typeof value === 'number' ? value : undefined;
}

function metadataString(result: ToolExecutionResult, key: string): string | undefined {
  const value = result.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** 执行结果 → 对外四态。拒绝类细分见 `HUMAN_DENIAL_HOST_REASONS` 与 refused 判据。 */
function mapExecutionResult(result: ToolExecutionResult): InteractiveRunCommandResult {
  if (result.success) {
    return {
      status: 'completed',
      output: result.output ?? '',
      exitCode: metadataNumber(result, 'exitCode') ?? 0,
    };
  }
  const reason = result.error ?? 'command execution failed';
  const code = hostReasonCode(result);
  const exitCode = metadataNumber(result, 'exitCode');
  if (code !== undefined && HUMAN_DENIAL_HOST_REASONS.has(code)) {
    return { status: 'denied', output: '', reason };
  }
  // 命令真跑过并带回退出码（PTY 路径非零退出）→ 按已执行上报，exitCode 如实带回。
  if (exitCode !== undefined) {
    return { status: 'completed', output: metadataString(result, 'output') ?? '', exitCode };
  }
  // 机器拒绝：硬毙清单 / 分类器 deny / exec-policy forbidden / 沙箱缺位（拒绝原文透传，
  // 绝不摘掉沙箱重试）。其余（spawn 失败、超时等执行故障）→ failed。
  const refused = code === HostReasonCode.PermissionClassifierDenied
    || code === HostReasonCode.OsSandboxUnavailable
    || result.metadata?.code === 'SANDBOX_UNAVAILABLE'
    || result.metadata?.failureCode === AgentFailureCode.PermissionDenied
    || reason.startsWith('Security: Command blocked')
    || reason.startsWith('Blocked by exec policy');
  return { status: refused ? 'refused' : 'failed', output: '', reason };
}

/**
 * 在会话的审批链上执行一次用户点击的命令。命令串原样进管道，不 trim、不改写；
 * 审批串与执行串都必须逐字节等于 payload。
 */
export async function runInteractiveCommand(
  input: InteractiveRunCommandInput,
): Promise<InteractiveRunCommandResult> {
  const { sessionId, command } = input ?? {} as InteractiveRunCommandInput;
  // 前置校验失败按 refused 返回，不建 executor、不碰审批链。
  if (typeof command !== 'string' || command.length === 0) {
    return { status: 'refused', output: '', reason: 'command must be a non-empty string' };
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { status: 'refused', output: '', reason: 'sessionId is required' };
  }
  const orchestrator = getTaskManager().getOrCreateCurrentOrchestrator(sessionId);
  if (!orchestrator) {
    return { status: 'refused', output: '', reason: 'no orchestrator for session' };
  }

  const requestPermission = async (
    request: PermissionRequestData,
  ): Promise<PermissionAskResult> => {
    const result = await orchestrator.requestExternalEnginePermission({
      ...request,
      forceConfirm: true,
    } as Omit<PermissionRequest, 'id' | 'timestamp'>);
    // updatedArgs 一律丢弃：执行的命令必须就是 payload。
    return result.updatedArgs === undefined ? result : { ...result, updatedArgs: undefined };
  };

  const executor = new ToolExecutor({
    workingDirectory: orchestrator.getWorkingDirectory(),
    forcePermissionHandler: true,
    ledgerOrigin: 'desktop',
    requestPermission,
  });

  const result = await executor.execute('Bash', { command }, { sessionId });
  return mapExecutionResult(result);
}
