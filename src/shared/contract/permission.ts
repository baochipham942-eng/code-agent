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
  | 'mcp';

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
export type PermissionResponse = 'allow' | 'allow_session' | 'deny';

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
