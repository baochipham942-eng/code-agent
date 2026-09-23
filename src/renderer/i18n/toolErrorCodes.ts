// host metadata.code 的用户文案。独立文件是因为 chatTranscript.ts 已贴 max-lines。
// 键是 host 下发的 code 原文。带 {param} 的句子由 metadata 同名字段填入。

export const toolErrorCodesZh = {
  USER_INPUT_TIMEOUT: {
    summary: '等待你的决定超时',
    detail: '当前是无头运行，已按安全规则拒绝；需要继续时请在有交互界面的会话里重新发起。',
  },
  DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED: {
    summary: '写入全局记忆需要你本人确认',
    detail: '这次没有写入；需要保存的话重新发起，并在确认窗口里点「确认」。',
  },
  WORKBENCH_SCOPE_DENIED: {
    summary: '当前工作台范围不允许使用这个工具',
    detail: '工具被工作台范围拦截；调整范围或改用范围内的工具。',
  },
  PROJECT_SOURCE_READ_ONLY: {
    summary: '项目来源是只读的，无法写入',
    detail: '该目录以只读挂载；写入请改用工作区内的可写路径。',
  },
  RUN_CONTEXT_MISMATCH: {
    summary: '运行上下文不匹配，这次调用已被拦截',
    detail: '这次调用不属于当前运行；刷新会话后重试。',
  },
  RUN_WORKSPACE_BOUNDARY: {
    summary: '命令只能在工作区范围内执行',
    detail: '指定的工作目录越出了工作区 Project Sources 边界。',
  },
  AMEND_PUSHED: {
    summary: '上一次提交已推送到远程，不能再 amend',
    detail: 'amend 会改写已公开的提交历史；请创建一个新提交。',
  },
  NO_PROJECT: {
    summary: '当前会话未绑定 Project，无法新增目录授权',
    detail: '请先在项目设置里建立 Project，再重试授权。',
  },
  UPDATE_FAILED: {
    summary: '授权写入失败：Project 状态已变化',
    detail: '请重试一次；若仍失败，刷新会话后再试。',
  },
  PR_ON_DEFAULT_BRANCH: {
    summary: '当前在默认分支 {branch}，不能从这里创建 PR',
    detail: '先切到一个功能分支，再重新创建 PR。',
  },
  PR_UNCOMMITTED_CHANGES: {
    summary: '有未提交的更改，不能创建 PR',
    detail: '先提交（commit）这些更改，再创建 PR。',
  },
  ENV_DEPENDENCY_MISSING: { summary: '缺少依赖 {dependency}，无法执行', detail: '请先安装：{installHint}，装好后重试。' },
  BROWSER_RESUME_STATE_EXPORT_FAILED: { summary: '浏览器登录状态没有保存成功', detail: '浏览器已正常关闭；下一轮可能需要重新登录。' },
  BROWSER_RESUME_STATE_IMPORT_FAILED: { summary: '浏览器登录状态恢复失败', detail: '新浏览器已启动，但未带上一轮的登录状态。' },
  BROWSER_COMPUTER_HIGH_RISK_BLOCKED: { summary: '高风险的浏览器或电脑操作已被拦截', detail: '支付、转账及同等级不可逆操作不能由 agent 直接执行。请由你本人完成。' },
  INJECTION_CEILING: {
    summary: '这个工具的完整定义超过单次加载上限',
    detail: '{name} 测得 {measured}，上限 {allowed}。没有载入不完整的定义。',
  },
};

export const toolErrorCodesEn: typeof toolErrorCodesZh = {
  USER_INPUT_TIMEOUT: {
    summary: 'Timed out waiting for your decision',
    detail: 'This headless run applied the safe denial rule. Retry from a session with an interactive UI to continue.',
  },
  DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED: {
    summary: 'Writing to global memory needs your confirmation',
    detail: 'Nothing was written. To save it, ask again and click "Confirm" in the confirmation window.',
  },
  WORKBENCH_SCOPE_DENIED: {
    summary: 'This tool is not allowed in the current workbench scope',
    detail: 'The tool was blocked by the workbench scope; adjust the scope or use an allowed tool.',
  },
  PROJECT_SOURCE_READ_ONLY: {
    summary: 'This project source is read-only and cannot be written',
    detail: 'The directory is mounted read-only; write to a writable path inside the workspace instead.',
  },
  RUN_CONTEXT_MISMATCH: {
    summary: 'Run context mismatch; this call was blocked',
    detail: 'The call does not belong to the current run; refresh the session and retry.',
  },
  RUN_WORKSPACE_BOUNDARY: {
    summary: 'Commands can only run inside the workspace',
    detail: 'The requested working directory is outside the workspace Project Sources boundary.',
  },
  AMEND_PUSHED: {
    summary: 'The last commit was already pushed; amend is blocked',
    detail: 'Amending would rewrite published history; create a new commit instead.',
  },
  NO_PROJECT: {
    summary: 'This session is not bound to a Project, so directory access cannot be granted',
    detail: 'Create a Project in project settings first, then retry the grant.',
  },
  UPDATE_FAILED: {
    summary: 'Grant write failed: the Project state changed',
    detail: 'Retry once; if it still fails, refresh the session and try again.',
  },
  PR_ON_DEFAULT_BRANCH: {
    summary: 'On the default branch {branch}; cannot create a PR from here',
    detail: 'Switch to a feature branch first, then create the PR again.',
  },
  PR_UNCOMMITTED_CHANGES: {
    summary: 'There are uncommitted changes; cannot create a PR',
    detail: 'Commit these changes first, then create the PR.',
  },
  ENV_DEPENDENCY_MISSING: { summary: 'Missing dependency {dependency}; cannot run', detail: 'Install it first: {installHint}, then retry.' },
  BROWSER_RESUME_STATE_EXPORT_FAILED: { summary: 'Browser login state could not be saved', detail: 'The browser closed normally; the next run may require login again.' },
  BROWSER_RESUME_STATE_IMPORT_FAILED: { summary: 'Browser login state could not be restored', detail: 'The new browser started without the previous run\'s login state.' },
  BROWSER_COMPUTER_HIGH_RISK_BLOCKED: { summary: 'A high-risk browser or computer action was blocked', detail: 'Payments, transfers, and similarly irreversible actions cannot be performed directly by the agent. Complete the action yourself.' },
  INJECTION_CEILING: {
    summary: 'This tool definition exceeds the single-load limit',
    detail: '{name} measured {measured}; the limit is {allowed}. No partial definition was loaded.',
  },
};
