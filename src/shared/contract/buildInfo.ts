export interface BuildInfo {
  appName: string;
  branch: string | null;
  commit: string | null;
  commitShort: string | null;
  dirty: boolean | null;
  worktree: string | null;
  /**
   * 执行安装的 worktree 绝对路径。可选：renderer 会被热更新独立升级，
   * 新 renderer + 旧 host 时这个字段不存在，此时按缺失处理而不是判整份 build-info 无效
   * （否则 About 面板会在最需要它排查「我这包到底是谁装的」时反而空白）。
   */
  installedFrom?: string | null;
  builtAt: string;
}
