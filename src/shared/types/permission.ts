// ============================================================================
// Permission Types
// ============================================================================

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
  };
  reason?: string;
  timestamp: number;
  dangerLevel?: 'normal' | 'warning' | 'danger';
}

// 权限响应（兼容旧版）
export type PermissionResponse = 'allow' | 'allow_session' | 'deny';

// 权限响应（新版，包含审批级别）
export interface PermissionResponseWithLevel {
  id: string;
  allowed: boolean;
  level: ApprovalLevel;
}
