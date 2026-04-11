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
  reason?: string;
  timestamp: number;
  dangerLevel?: 'normal' | 'warning' | 'danger';
  /** Decision trace: why this permission was requested (populated on deny/ask) */
  decisionTrace?: import('./decisionTrace').DecisionTrace;
}

// 权限响应（兼容旧版）
export type PermissionResponse = 'allow' | 'allow_session' | 'deny';

// 权限响应（新版，包含审批级别）
export interface PermissionResponseWithLevel {
  id: string;
  allowed: boolean;
  level: ApprovalLevel;
}
