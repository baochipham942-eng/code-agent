// ============================================================================
// MiMo-Code（OpenCode fork）外部引擎权限常量
// ============================================================================
//
// 背景：MiMo-Code 的 `mimo run` 在非 TTY（app 子进程）下，一旦某工具的权限解析成
// `ask`（如越权访问项目外目录的 external_directory），会弹交互式审批并阻塞等待批准，
// 子进程永远不返回 → 适配器超时挂死。`--dangerously-skip-permissions` 会 auto-approve
// 一切（违反 read-only，禁用）；`--never-ask` 明确「permissions excluded」，不影响权限。
//
// 真正的杠杆是 OpenCode 的配置式权限模型：`permission` 块按工具名映射 allow/ask/deny，
// `"*"` 是 catch-all 默认。MiMo 暴露 `MIMOCODE_PERMISSION` 环境变量，取值为 JSON，
// 启动时 deep-merge 进 permission 配置（已通过二进制 strings 核实：
// `if(env.MIMOCODE_PERMISSION) cfg.permission = merge(cfg.permission ?? {}, JSON.parse(env))`）。
//
// read-only 策略：`"*": "deny"` 作 catch-all（任何未列工具 → deny 而非 ask，模型收到
// 拒绝后继续，不阻塞），只 allow 只读工具（read/glob/grep/list），写/越权/外联工具显式 deny。
// 关键不变量：**任何工具都不得解析成 `ask`**，否则非 TTY 下会再次阻塞挂死。

/** 注入 MiMo 权限配置的环境变量名（OpenCode `OPENCODE_PERMISSION` 的 MiMo 重命名）。 */
export const MIMO_CODE_PERMISSION_ENV = 'MIMOCODE_PERMISSION';

/**
 * read_only profile 对应的 MiMo 权限策略。
 * 以 JSON 字符串注入 `MIMOCODE_PERMISSION`，使 `mimo run` 非交互且只读：
 * 允许 read/glob/grep/list 只读工具，拒绝一切写/执行/越权/外联工具，catch-all 兜底 deny。
 */
export const MIMO_CODE_READ_ONLY_PERMISSION: Readonly<Record<string, 'allow' | 'deny'>> = {
  '*': 'deny',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  lsp: 'allow',
  bash: 'deny',
  edit: 'deny',
  write: 'deny',
  patch: 'deny',
  task: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  external_directory: 'deny',
  skill: 'deny',
  question: 'deny',
  doom_loop: 'deny',
} as const;
