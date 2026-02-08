// ============================================================================
// PermissionDialog - 权限请求对话框主组件
// ============================================================================
// 基于 Claude Code 设计，提供多级审批选项和权限记忆功能

import React, { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/appStore';
import { usePermissionStore, type PermissionRequestForMemory } from '../../stores/permissionStore';
import { PermissionHeader } from './PermissionHeader';
import { DangerWarning } from './DangerWarning';
import { RequestDetails } from './RequestDetails';
import { ApprovalOptions } from './ApprovalOptions';
import type { PermissionRequest, ApprovalLevel, PermissionType } from './types';
import type { PermissionResponse } from '@shared/types';
import { IPC_CHANNELS } from '@shared/ipc';
import { getPermissionConfig, isDangerousCommand, getDangerReason } from './utils';

// 将共享类型的 PermissionRequest 转换为本地类型
function normalizeRequest(
  request: import('@shared/types').PermissionRequest
): PermissionRequest {
  return {
    id: request.id,
    tool: request.tool,
    type: request.type as PermissionType,
    reason: request.reason,
    details: {
      filePath: request.details.path,
      command: request.details.command,
      url: request.details.url,
      changes: request.details.changes,
      path: request.details.path,
      preview: request.details.preview,
    },
    timestamp: request.timestamp,
  };
}

// 转换为权限记忆 store 使用的格式
function toMemoryRequest(request: PermissionRequest): PermissionRequestForMemory {
  return {
    id: request.id,
    tool: request.tool,
    type: request.type,
    details: {
      filePath: request.details.filePath || request.details.path,
      command: request.details.command,
      url: request.details.url,
      server: request.details.server,
      toolName: request.details.toolName,
    },
  };
}

export function PermissionDialog() {
  const { pendingPermissionRequest, setPendingPermissionRequest } = useAppStore();
  const { checkMemory, saveMemory } = usePermissionStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  // 用于防止重复处理同一请求
  const processedRequestRef = useRef<string | null>(null);

  // 如果没有待处理的权限请求，不渲染
  if (!pendingPermissionRequest) return null;

  // 规范化请求
  const request = normalizeRequest(pendingPermissionRequest);
  const config = getPermissionConfig(request.type);

  // 检测是否为危险命令
  const isDangerous =
    request.type === 'dangerous_command' ||
    (request.type === 'command' && isDangerousCommand(request.details.command));

  // 获取危险原因
  const dangerReason = isDangerous ? getDangerReason(request.details.command) : undefined;

  // 检查是否有记忆的决定（只在首次渲染时检查，避免保存后立即触发）
  const memoryRequest = toMemoryRequest(request);
  // 只有当这是一个新请求时才检查记忆
  const isNewRequest = processedRequestRef.current !== request.id;
  const memoryResult = isNewRequest ? checkMemory(memoryRequest) : null;

  // 将 ApprovalLevel 转换为 PermissionResponse
  const toPermissionResponse = (level: ApprovalLevel): PermissionResponse => {
    switch (level) {
      case 'once':
      case 'always':
        return 'allow';
      case 'session':
        return 'allow_session';
      case 'deny':
      case 'never':
      default:
        return 'deny';
    }
  };

  // 处理审批决定
  const handleApproval = useCallback(
    (level: ApprovalLevel) => {
      // 防止重复处理同一请求
      if (processedRequestRef.current === request.id) {
        return;
      }
      processedRequestRef.current = request.id;

      // 保存记忆（如果是 session/always/never）
      if (level === 'session' || level === 'always' || level === 'never') {
        // 在回调内部构建 memoryRequest，避免闭包问题
        const memoryReq: PermissionRequestForMemory = {
          id: request.id,
          tool: request.tool,
          type: request.type as import('../../stores/permissionStore').PermissionType,
          details: {
            filePath: request.details.filePath || request.details.path,
            command: request.details.command,
            url: request.details.url,
            server: request.details.server,
            toolName: request.details.toolName,
          },
        };
        saveMemory(memoryReq, level);
      }

      // 转换为 IPC 响应格式
      const response = toPermissionResponse(level);

      // 通过 IPC 发送响应
      if (window.electronAPI?.invoke) {
        window.electronAPI.invoke(
          IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
          request.id,
          response
        );
      }

      // 清除待处理请求
      setPendingPermissionRequest(null);
    },
    // 使用 request 对象的关键属性作为依赖
    [request.id, request.tool, request.type, request.details, saveMemory, setPendingPermissionRequest]
  );

  // 如果有记忆的决定，自动应用（只对新请求生效）
  useEffect(() => {
    if (memoryResult && isNewRequest) {
      // 短暂延迟，让用户有机会看到对话框
      const timer = setTimeout(() => {
        handleApproval(memoryResult);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [memoryResult, handleApproval, isNewRequest]);

  // 键盘快捷键处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 忽略在输入框中的按键
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const key = e.key.toLowerCase();

      switch (key) {
        case 'y':
          e.preventDefault();
          handleApproval('once');
          break;
        case 'n':
          e.preventDefault();
          if (e.shiftKey) {
            handleApproval('never');
          } else {
            handleApproval('deny');
          }
          break;
        case 's':
          if (!isDangerous) {
            e.preventDefault();
            handleApproval('session');
          }
          break;
        case 'a':
          if (e.shiftKey && !isDangerous) {
            e.preventDefault();
            handleApproval('always');
          }
          break;
        case 'escape':
          e.preventDefault();
          handleApproval('deny');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleApproval, isDangerous]);

  // 聚焦对话框以接收键盘事件
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="permission-dialog-title"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`
          w-full max-w-lg mx-4
          bg-zinc-900 rounded-lg shadow-2xl
          border-2
          outline-none
          ${isDangerous ? 'border-red-500' : config.borderColor}
        `}
      >
        {/* 头部 */}
        <PermissionHeader
          config={config}
          toolName={request.tool}
          isDangerous={isDangerous}
          onClose={() => handleApproval('deny')}
        />

        {/* 内容区域 */}
        <div className="p-4 space-y-4">
          {/* 危险警告 */}
          {isDangerous && <DangerWarning reason={dangerReason || undefined} />}

          {/* 请求原因 */}
          {request.reason && (
            <p className="text-zinc-300 text-sm">{request.reason}</p>
          )}

          {/* 请求详情 */}
          <RequestDetails request={request} />
        </div>

        {/* 审批选项 */}
        <ApprovalOptions onApproval={handleApproval} isDangerous={isDangerous} />
      </div>
    </div>
  );
}

// 导出类型
export type { PermissionRequest, ApprovalLevel, PermissionType } from './types';
