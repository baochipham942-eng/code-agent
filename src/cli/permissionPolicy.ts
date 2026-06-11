// ============================================================================
// CLI Permission Policy — 非交互模式的安全默认（借鉴 MiMoCode run 命令设计）
// ============================================================================
//
// CLI run/batch 没有审批 UI，无法人工确认。安全默认：需要人工确认的权限
// （dangerous_command / forceConfirm / dangerLevel=danger）自动拒绝并告知模型，
// 其余照常放行，防止 CI 挂起或危险操作被静默批准。
// `--dangerously-skip-permissions` 是显式逃生门，恢复全自动批准。

import type { PermissionRequestData } from '../main/tools/types';

export interface CLIPermissionPolicyOptions {
  /** 显式逃生门：恢复全自动批准（含危险操作） */
  dangerouslySkipPermissions?: boolean;
  /** 拒绝时的告警输出（默认 console.error，避免污染 stdout 的 JSON 输出） */
  warn?: (message: string) => void;
}

/** 判定该权限请求是否需要人工确认（非交互模式下无法满足 → 拒绝） */
export function requiresHumanConfirmation(request: PermissionRequestData): boolean {
  return (
    request.type === 'dangerous_command'
    || request.forceConfirm === true
    || request.dangerLevel === 'danger'
  );
}

export function createCLIPermissionHandler(
  options: CLIPermissionPolicyOptions = {},
): (request: PermissionRequestData) => Promise<boolean> {
  const warn = options.warn ?? ((message: string) => console.error(message));

  return async (request: PermissionRequestData): Promise<boolean> => {
    if (options.dangerouslySkipPermissions) {
      return true;
    }
    if (requiresHumanConfirmation(request)) {
      const target = String(
        request.details?.command || request.details?.path || request.details?.url || request.tool,
      );
      warn(
        `[permission] 非交互模式自动拒绝需人工确认的操作: ${request.tool} (${target})。`
        + ' 如需放行请使用 --dangerously-skip-permissions（危险）。',
      );
      return false;
    }
    return true;
  };
}
