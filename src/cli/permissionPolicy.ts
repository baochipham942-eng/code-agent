// ============================================================================
// CLI Permission Policy — 非交互模式的安全默认（借鉴 MiMoCode run 命令设计）
// ============================================================================
//
// CLI run/batch 没有审批 UI，无法人工确认。凡是已经进入 requestPermission 的操作
// 都在等人批准；没有真实批准动作时必须拒绝，不能以布尔 true 冒充用户响应。
// `--dangerously-skip-permissions` 是显式逃生门，恢复全自动批准。

import type { PermissionRequestData } from '../host/tools/types';
import type { PermissionAskResult } from '../shared/contract/permission';

export interface CLIPermissionPolicyOptions {
  /** 显式逃生门：恢复全自动批准（含危险操作） */
  dangerouslySkipPermissions?: boolean;
  /** 拒绝时的告警输出（默认 console.error，避免污染 stdout 的 JSON 输出） */
  warn?: (message: string) => void;
}

/** requestPermission 代表一个等待人工回答的 ask；CLI/web headless 无法回答。 */
export function requiresHumanConfirmation(_request: PermissionRequestData): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// 交互审批注册点（P4）：Ink TUI 启动时注册审批卡实现，退出时注销。
// headless（非 TTY / 管道 / web）永远注册不到，维持 no-approval-ui fail-closed。
// ---------------------------------------------------------------------------

export type InteractiveApprovalProvider = (request: PermissionRequestData) => Promise<PermissionAskResult>;

let interactiveApprovalProvider: InteractiveApprovalProvider | null = null;

export function setInteractiveApprovalProvider(provider: InteractiveApprovalProvider | null): void {
  interactiveApprovalProvider = provider;
}

/** 测试/诊断用：当前是否有交互审批通道 */
export function hasInteractiveApprovalProvider(): boolean {
  return interactiveApprovalProvider !== null;
}

export function createCLIPermissionHandler(
  options: CLIPermissionPolicyOptions = {},
): (request: PermissionRequestData) => Promise<PermissionAskResult> {
  const warn = options.warn ?? ((message: string) => console.error(message));

  return async (request: PermissionRequestData): Promise<PermissionAskResult> => {
    if (options.dangerouslySkipPermissions) {
      return { approved: true };
    }
    // 交互通道优先（Ink TUI 审批卡）；调用时现查，注册/注销不需要重建 executor
    const provider = interactiveApprovalProvider;
    if (provider) {
      return provider(request);
    }
    if (requiresHumanConfirmation(request)) {
      const target = String(
        request.details?.command || request.details?.path || request.details?.url || request.tool,
      );
      warn(
        `[permission] 非交互模式自动拒绝需人工确认的操作: ${request.tool} (${target})。`
        + ' CLI 无交互确认能力，重试结果相同；'
        + '请改用 GUI/交互模式，或加 --dangerously-skip-permissions（危险）放行。',
      );
      // 拒的是这条路的**环境**（没有审批 UI），不是用户——账本/模型文案都不许再写成 user。
      return { approved: false, denialSource: 'no-approval-ui' };
    }
    return { approved: true };
  };
}

