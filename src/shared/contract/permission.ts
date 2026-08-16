// ============================================================================
// Permission Types
// ============================================================================

/**
 * 权限预设类型
 * - strict: 最严格，所有操作需确认
 * - development: 开发模式，项目目录内自动批准
 * - ci: CI 环境，完全信任
 * - custom: 用户自定义
 */
export type PermissionPreset = 'strict' | 'development' | 'ci' | 'custom';

// 权限类型
export type PermissionType =
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'file_delete'
  | 'command'
  | 'dangerous_command'
  | 'network'
  | 'mcp'
  /** request_directory 工具：申请把工作区外的一个目录加为 Project Source */
  | 'directory_access';

// 审批级别
export type ApprovalLevel =
  | 'once'      // 允许一次
  | 'deny'      // 拒绝
  | 'session'   // 本次会话允许
  | 'always'    // 始终允许
  | 'never';    // 永不允许

// 权限请求
export interface PermissionRequest {
  id: string;
  sessionId?: string;
  forceConfirm?: boolean;
  type: PermissionType;
  tool: string;
  details: {
    path?: string;
    filePath?: string;
    command?: string;
    url?: string;
    changes?: string;
    oldContent?: string;
    newContent?: string;
    server?: string;
    toolName?: string;
    /**
     * B4：external 工具的授权 target 精确串（收件人/频道 id 等）。由 toolExecutor 在需人工审批时
     * 透传，供停车审批卡出「每次都允许发 <target>」铸权入口；模型侧无入口（no-self-grant）。
     */
    standingGrantTarget?: string;
    /** directory_access：申请的访问档位（request_directory 工具透传） */
    requestedAccess?: 'read_only' | 'read_write';
    /** E2: 确认门控预览信息 */
    preview?: {
      type: 'diff' | 'command' | 'network' | 'generic';
      before?: string;
      after?: string;
      diff?: string;
      summary: string;
    };
  };
  /** 人类可读原因文案（向后兼容，旧路径仍只读此字段） */
  reason?: string;
  /** 结构化原因码（可追溯/可测试/可 i18n，与 `reason` 文案并行，optional 向后兼容） */
  reasonCode?: PermissionRequestReason;
  /** User-facing data boundary shown in permission and privacy surfaces. */
  boundary?: import('./permissionBoundary').PermissionBoundaryRef;
  timestamp: number;
  dangerLevel?: 'normal' | 'warning' | 'danger';
  /** Decision trace: why this permission was requested (populated on deny/ask) */
  decisionTrace?: import('./decisionTrace').DecisionTrace;
}

// 权限响应（兼容旧版）
// - allow_standing（B4）：批准本次 + 在该 automation 上铸造 (工具, target) 长期授权规则。
//   仅停车审批（无人值守 automation）+ external+有 target 时可用；铸造由人工点击触发，
//   模型侧无任何入口（no-self-grant）。
export type PermissionResponse = 'allow' | 'allow_session' | 'allow_standing' | 'deny';

/**
 * 审批响应投递结果——「点了允许之后到底发生了什么」的唯一口径。
 *
 * 2026-07-26 真机：整条投递链（HTTP → IPC → TaskManager → Orchestrator）**每一层失败
 * 都不留痕，成功也不留痕**，于是「点击没到 host」和「到了但没生效」在日志里长得一模一样，
 * 排查整整卡在这个区分上。所以每层都必须回报自己死在哪一步，而不是 void + 静默 return。
 */
export type PermissionDeliveryOutcome =
  /** 已交给持有该 pending promise 的 orchestrator */
  | 'delivered'
  /** orchestrator 在，但它没有这个 requestId（已超时删除 / 已被抢答 / id 打错） */
  | 'unknown_request'
  /** 该 session 没有活跃 orchestrator（进程重启后内存里的 pending promise 已不存在） */
  | 'no_orchestrator'
  /** 请求没带 sessionId，且当前也没有活跃会话可兜底 */
  | 'no_session';

/**
 * 「这次审批是被谁拒的」——`'user'` 之外**全部是机器做的判断**。
 *
 * 2026-08-15 立此类型的原因：`toolExecutor` 的 ask-denied 分支把 reason 写死成 `'user'`，
 * 而 `/api/run`（桌面 renderer 每次发送都走这条）的审批处理器是 `createCLIPermissionHandler`，
 * `requiresHumanConfirmation` 恒 true ⇒ **一律自动拒绝，用户压根没看见过审批卡**。
 * 账本把机器拒的记成人拒的，事后审计分不出来（与 08-13「devModeAutoApprove 冒名 user」同族）。
 *
 * 判据来源必须是**处理器自己回报**，不许按调用方名字枚举——那种清单一加新入口就漏。
 */
export type PermissionDenialSource =
  /** 真人在审批界面上点了拒绝 */
  | 'user'
  /** 运行环境没有审批界面（非交互 CLI / web headless），需确认的一律 fail-closed 自动拒 */
  | 'no-approval-ui'
  /** 审批请求已发出但无人应答，超时自动拒 */
  | 'timeout'
  /** 会话取消 / 新消息到达，挂起的审批被统一解除 */
  | 'cancelled'
  /** 依赖不可用（停车台账等），按安全侧默认拒 */
  | 'fail-closed';

/** 「这次审批是谁批准的」；机器批准必须显式自报，不能沿用真人批准的默认值。 */
type PermissionApprovalSource =
  /** 真人在审批界面上点了允许；也是旧 boolean true 的兼容语义 */
  | 'user'
  /** dev 槽里的 devModeAutoApprove 机器放行 */
  | 'dev-auto-approve';

/** 审批处理器的富返回值。裸 boolean 仍然合法（等价 `user` 语义），旧实现无需改动。 */
export interface PermissionAskResult {
  approved: boolean;
  /** 仅 approved=true 时有意义；缺省按 `'user'` 解释。 */
  approvalSource?: PermissionApprovalSource;
  /** 仅 approved=false 时有意义；缺省按 `'user'` 解释。 */
  denialSource?: PermissionDenialSource;
  /** 给模型看的真实原因文案；缺省由 `permissionDenialError` 按 denialSource 生成。 */
  message?: string;
}

export type RequestPermissionResult = boolean | PermissionAskResult;

/** 归一化审批处理器返回值：裸 boolean 的 false 记为真人拒绝（旧契约语义）。 */
export function normalizePermissionAskResult(
  result: RequestPermissionResult,
): PermissionAskResult & { denialSource: PermissionDenialSource | undefined } {
  if (typeof result === 'boolean') {
    return { approved: result, denialSource: result ? undefined : 'user' };
  }
  return {
    ...result,
    denialSource: result.approved ? undefined : (result.denialSource ?? 'user'),
  };
}

// ============================================================================
// Permission Request Reason (enumerated, traceable, i18n-able)
// ============================================================================

/**
 * 权限确认请求的结构化原因码。
 *
 * 与人类可读的 `PermissionRequest.reason` 文案并行存在：`reasonCode` 用于可追溯
 * （日志/审计/对账）、可测试（断言分类正确）、可 i18n（文案由 `permissionReasonText`
 * 集中映射）。旧序列化的 request 没有 `reasonCode` 字段 —— 字段为 optional，
 * 渲染层在 `reason` 文案缺失且 `reasonCode` 缺失时不应崩溃（见 PermissionCard fallback）。
 */
export enum PermissionRequestReason {
  /** 写入工作区目录之外的文件 */
  FileWriteOutsideWorkspace = 'file_write_outside_workspace',
  /** 执行 Shell 命令（潜在高风险操作面） */
  ShellHighRisk = 'shell_high_risk',
  /** 访问外部网络资源 */
  NetworkEgress = 'network_egress',
  /** 调用 MCP 服务器工具 */
  McpTool = 'mcp_tool',
  /** 未归类的原因（兜底；default 工具分支统一落此值，避免空白原因） */
  Unknown = 'unknown',
}

/**
 * 把结构化原因码映射为人类可读文案（中文）。
 *
 * 这是 reason 文案的**唯一来源**（i18n 集中点）。switch 穷尽所有枚举值，
 * 末尾的 `never` 守卫保证：未来给枚举新增值却忘了补文案时，TypeScript 编译报错。
 */
export function permissionReasonText(code: PermissionRequestReason): string {
  switch (code) {
    case PermissionRequestReason.FileWriteOutsideWorkspace:
      return '写入工作区外的文件';
    case PermissionRequestReason.ShellHighRisk:
      return '执行 Shell 命令';
    case PermissionRequestReason.NetworkEgress:
      return '访问外部网络资源';
    case PermissionRequestReason.McpTool:
      return '调用 MCP 服务器工具';
    case PermissionRequestReason.Unknown:
      return '此操作需要你的确认';
    default: {
      // 穷尽性守卫：新增枚举值未补文案时此处编译报错
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}
