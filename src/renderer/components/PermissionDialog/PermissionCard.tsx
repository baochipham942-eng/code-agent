// ============================================================================
// PermissionCard - 浮动在 ChatInput 上方的权限审批卡片
// 替代全屏遮罩的 PermissionDialog，用户审批时仍能看到对话上下文
// ============================================================================

import React, { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePermissionStore, type PermissionRequestForMemory } from '../../stores/permissionStore';
import { PermissionHeader } from './PermissionHeader';
import { DangerWarning } from './DangerWarning';
import { RequestDetails } from './RequestDetails';
import { ApprovalOptionsCompact } from './ApprovalOptionsCompact';
import type { PermissionRequest, ApprovalLevel, PermissionType } from './types';
import type { PermissionResponse } from '@shared/types';
import { IPC_CHANNELS } from '@shared/ipc';
import { getPermissionConfig, isDangerousCommand, getDangerReason } from './utils';
import ipcService from '../../services/ipcService';

// 将共享类型的 PermissionRequest 转换为本地类型
function normalizeRequest(
  request: import('@shared/types').PermissionRequest
): PermissionRequest {
  return {
    id: request.id,
    sessionId: request.sessionId,
    forceConfirm: request.forceConfirm,
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

export function PermissionCard() {
  const { pendingPermissionRequest, pendingPermissionSessionId, setPendingPermissionRequest } = useAppStore();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const { checkMemory, saveMemory } = usePermissionStore();
  const cardRef = useRef<HTMLDivElement>(null);
  const processedRequestRef = useRef<string | null>(null);

  // 如果没有待处理的权限请求，不渲染
  if (!pendingPermissionRequest) return null;
  if (pendingPermissionSessionId && currentSessionId && pendingPermissionSessionId !== currentSessionId) {
    return null;
  }

  const request = normalizeRequest(pendingPermissionRequest);
  const config = getPermissionConfig(request.type);

  const isDangerous =
    request.forceConfirm === true ||
    request.type === 'dangerous_command' ||
    (request.type === 'command' && isDangerousCommand(request.details.command));

  const dangerReason = isDangerous ? getDangerReason(request.details.command) : undefined;

  const memoryRequest = toMemoryRequest(request);
  const isNewRequest = processedRequestRef.current !== request.id;
  const memoryResult = isNewRequest && request.forceConfirm !== true ? checkMemory(memoryRequest) : null;

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

  const handleApproval = useCallback(
    (level: ApprovalLevel) => {
      if (processedRequestRef.current === request.id) return;
      processedRequestRef.current = request.id;

      if ((level === 'session' || level === 'always' || level === 'never') && request.forceConfirm !== true) {
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

      const response = toPermissionResponse(level);
      if (ipcService.isAvailable()) {
        ipcService.invoke(
          IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
          request.id,
          response,
          request.sessionId
        );
      }
      setPendingPermissionRequest(null);
    },
    [request.id, request.tool, request.type, request.details, saveMemory, setPendingPermissionRequest]
  );

  // 自动应用记忆的决定
  useEffect(() => {
    if (memoryResult && isNewRequest) {
      const timer = setTimeout(() => {
        handleApproval(memoryResult);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [memoryResult, handleApproval, isNewRequest]);

  // 键盘快捷键 — stopPropagation 防止触发 ChatView 的 Esc+Esc
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
          e.stopPropagation();
          handleApproval('once');
          break;
        case 'n':
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            handleApproval('never');
          } else {
            handleApproval('deny');
          }
          break;
        case 's':
          if (!isDangerous) {
            e.preventDefault();
            e.stopPropagation();
            handleApproval('session');
          }
          break;
        case 'a':
          if (e.shiftKey && !isDangerous) {
            e.preventDefault();
            e.stopPropagation();
            handleApproval('always');
          }
          break;
        case 'escape':
          e.preventDefault();
          e.stopPropagation();
          handleApproval('deny');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleApproval, isDangerous]);

  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  return (
    <div className="w-full px-6 animate-slideUp">
      <div
        ref={cardRef}
        tabIndex={-1}
        className={`
          w-full
          bg-zinc-900 rounded-lg shadow-2xl
          border-2 outline-none
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

        {/* 内容区域 - 紧凑布局 */}
        <div className="px-4 py-3 space-y-2">
          {isDangerous && <DangerWarning reason={dangerReason || undefined} />}

          {request.reason && (
            <p className="text-zinc-400 text-sm">{request.reason}</p>
          )}

          <RequestDetails request={request} />
        </div>

        {/* 审批选项 - 水平排列 */}
        <ApprovalOptionsCompact onApproval={handleApproval} isDangerous={isDangerous} />
      </div>
    </div>
  );
}
