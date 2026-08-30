// ============================================================================
// `!` shell 直通的唯一通道（readline 与 Ink 两条交互路径共用）。
//
// 必须走 ToolExecutor 正式链路：权限分类器/审批卡（权限证据）、审计账本、
// 输出截断、cwd、超时全部继承。历史欠账是 readline 路径的 execSync 直通
// （绕权限分类器），已收口到本模块——新增调用方一律走这里，禁止再开旁路。
// ============================================================================

import type { ToolExecutionResult } from '../../host/tools/types';

export async function runDirectShellCommand(command: string): Promise<ToolExecutionResult> {
  const { getToolExecutor } = await import('../bootstrap');
  const executor = getToolExecutor();
  if (!executor) {
    return { success: false, error: '工具执行器未初始化，无法执行 shell 命令' };
  }
  // 进程级共享 executor 的 workingDirectory 已由 bootstrap 同步到项目目录；
  // 权限请求经 createCLIPermissionHandler → Ink 审批卡 / 非交互 fail-closed。
  return executor.execute('bash', { command }, {});
}
