// ============================================================================
// PermissionDialog - Type Definitions
// ============================================================================

import type { ReactNode } from 'react';

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

// 危险等级
export type DangerLevel = 'normal' | 'warning' | 'danger';

// 权限请求详情
export interface PermissionRequestDetails {
  filePath?: string;
  command?: string;
  url?: string;
  oldContent?: string;
  newContent?: string;
  changes?: string;
  server?: string;
  toolName?: string;
  path?: string; // 兼容旧版 API
}

// 权限请求
export interface PermissionRequest {
  id: string;
  tool: string;
  type: PermissionType;
  reason?: string;
  details: PermissionRequestDetails;
  dangerLevel?: DangerLevel;
  timestamp?: number;
}

// 权限配置
export interface PermissionConfig {
  icon: ReactNode;
  title: string;
  color: string;
  bgColor: string;
  borderColor: string;
}

// 审批选项
export interface ApprovalOption {
  level: ApprovalLevel;
  label: string;
  shortcut: string;
  icon: ReactNode;
  color: string;
  show: boolean;
}
