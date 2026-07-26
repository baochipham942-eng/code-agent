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
import type { PermissionResponse } from '@shared/contract';
import { permissionReasonText } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { getPermissionConfig, isDangerousCommand, getDangerReason } from './utils';
import ipcService from '../../services/ipcService';
import { toast } from '../../hooks/useToast';
import { claimApprovalResponse, releaseApprovalResponse } from '../../utils/approvalResponseGuard';

// 将共享类型的 PermissionRequest 转换为本地类型
function normalizeRequest(
  request: import('@shared/contract').PermissionRequest
): PermissionRequest {
  return {
    id: request.id,
    sessionId: request.sessionId,
    forceConfirm: request.forceConfirm,
    tool: request.tool,
    type: request.type as PermissionType,
    reason: request.reason,
    reasonCode: request.reasonCode,
    dangerLevel: request.dangerLevel,
    boundary: request.boundary,
    details: {
      filePath: request.details.path,
      command: request.details.command,
      url: request.details.url,
      changes: request.details.changes,
      server: request.details.server,
      toolName: request.details.toolName,
      path: request.details.path,
      preview: request.details.preview,
    },
    timestamp: request.timestamp,
    decisionTrace: request.decisionTrace,
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

  const request = pendingPermissionRequest && !(
    pendingPermissionSessionId &&
    currentSessionId &&
    pendingPermissionSessionId !== currentSessionId
  )
    ? normalizeRequest(pendingPermissionRequest)
    : null;

  // 「这操作本身危险」与「这次必须你亲手点」是两件事，卡上必须分开表达。
  //
  // host 侧的 forceConfirm 同时被两个来源置位：confirmationGate 的真风险评估
  // （它另外还给出 dangerLevel），和 readOnly / 通话抬严这类**流程性**要求
  // （档位规定逐次确认，与内容危险度无关）。此前这里把 forceConfirm 直接当危险，
  // 于是往工作目录写个 hello 也会顶着红框和「这是一个危险命令」——
  // 红卡成了常态，真危险那次反而淹在里面。
  const isDangerous =
    request !== null &&
    (request.dangerLevel === 'danger' ||
      request.type === 'dangerous_command' ||
      (request.type === 'command' && isDangerousCommand(request.details.command)));

  // forceConfirm 该有的职责一点没松：不许走「会话/始终」这类常驻授权，必须逐次点。
  const hideStandingGrants = isDangerous || request?.forceConfirm === true;

  const memoryRequest = request ? toMemoryRequest(request) : null;
  const isNewRequest = request !== null && processedRequestRef.current !== request.id;
  const memoryResult = memoryRequest && isNewRequest && request?.forceConfirm !== true
    ? checkMemory(memoryRequest)
    : null;

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
    async (level: ApprovalLevel) => {
      if (!request) return;

      const requestSnapshot = pendingPermissionRequest;
      const requestSessionId = pendingPermissionSessionId;
      if (processedRequestRef.current === request.id) return;
      if (!claimApprovalResponse(request.id)) return;
      processedRequestRef.current = request.id;

      try {
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
          try {
            saveMemory(memoryReq, level);
          } catch (error) {
            console.error('[PermissionCard] Failed to save approval memory', error);
          }
        }

        const response = toPermissionResponse(level);
        if (!ipcService.isAvailable()) throw new Error('IPC unavailable');
        await ipcService.invoke(
          IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
          request.id,
          response,
          request.sessionId
        );
        setPendingPermissionRequest(null);
      } catch {
        processedRequestRef.current = null;
        releaseApprovalResponse(request.id);
        setPendingPermissionRequest(requestSnapshot, requestSessionId);
        toast.error('审批响应发送失败，请重试');
      }
    },
    [
      pendingPermissionRequest,
      pendingPermissionSessionId,
      request?.id,
      request?.sessionId,
      request?.forceConfirm,
      request?.tool,
      request?.type,
      request?.details,
      saveMemory,
      setPendingPermissionRequest,
    ]
  );

  // 自动应用记忆的决定
  useEffect(() => {
    if (!request || !memoryResult || !isNewRequest) return;

    const timer = setTimeout(() => {
      handleApproval(memoryResult);
    }, 100);
    return () => clearTimeout(timer);
  }, [request, memoryResult, handleApproval, isNewRequest]);

  // 键盘快捷键 — stopPropagation 防止触发 ChatView 的 Esc+Esc
  useEffect(() => {
    if (!request) return;

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
          if (!hideStandingGrants) {
            e.preventDefault();
            e.stopPropagation();
            handleApproval('session');
          }
          break;
        case 'a':
          if (e.shiftKey && !hideStandingGrants) {
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
  }, [request, handleApproval, hideStandingGrants]);

  useEffect(() => {
    if (!request) return;
    cardRef.current?.focus();
  }, [request?.id]);

  // 如果没有当前会话可见的待处理权限请求，不渲染
  if (!request) return null;

  const config = getPermissionConfig(request.type);
  const dangerReason = isDangerous ? getDangerReason(request.details.command) : undefined;

  return (
    <div className="w-full px-4 animate-slideUp">
      <div
        ref={cardRef}
        tabIndex={-1}
        className={`
          w-full
          max-w-3xl mx-auto
          bg-zinc-900 rounded-lg shadow-2xl
          border-2 outline-hidden
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

          {(request.reason || (request.reasonCode && permissionReasonText(request.reasonCode))) && (
            <p className="text-zinc-400 text-sm">
              {request.reason || (request.reasonCode ? permissionReasonText(request.reasonCode) : '')}
            </p>
          )}

          <RequestDetails request={request} />
        </div>

        {/* 审批选项 - 水平排列 */}
        <ApprovalOptionsCompact onApproval={handleApproval} hideStandingGrants={hideStandingGrants} />
      </div>
    </div>
  );
}
