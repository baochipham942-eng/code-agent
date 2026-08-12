// ============================================================================
// CLI Permission Policy — 非交互模式的安全默认（借鉴 MiMoCode run 命令设计）
// ============================================================================
//
// CLI run/batch 没有审批 UI，无法人工确认。凡是已经进入 requestPermission 的操作
// 都在等人批准；没有真实批准动作时必须拒绝，不能以布尔 true 冒充用户响应。
// `--dangerously-skip-permissions` 是显式逃生门，恢复全自动批准。

import type { PermissionRequestData } from '../host/tools/types';

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
