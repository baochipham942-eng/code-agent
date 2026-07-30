// ============================================================================
// PermissionCard - 浮动在 ChatInput 上方的权限审批卡片
// 替代全屏遮罩的 PermissionDialog，用户审批时仍能看到对话上下文
//
// 2026-07-29 拍板：视觉骨架统一迁移到 DecisionCard（与 AskUserQuestion 提问卡
// 同形）——审批级别变成选项行，底部 ghost 取消 + primary 确认（选中后才可点）。
// 数据流/store/IPC 不变；y/n/s/a 字母快捷键保留直发（点了就执行，不经确认键），
// Shift+N=永不允许 作为隐藏直发保留；授权记忆命中仍 100ms 自动执行、不弹卡。
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePermissionStore, type PermissionRequestForMemory } from '../../stores/permissionStore';
import { DecisionCard, isEditableTarget, type DecisionOption } from '../DecisionCard';
import { RequestDetails } from './RequestDetails';
import type { PermissionRequest, ApprovalLevel, PermissionType } from './types';
import type { PermissionResponse } from '@shared/contract';
import { permissionReasonText } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { getPermissionConfig, isDangerousCommand, getDangerReason, formatFilePath } from './utils';
import { useI18n, type Translations } from '../../hooks/useI18n';
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

// 一行问题句（「允许写入 ~/work/report.md？」）；目标缺失时回退到通用问法
function permissionQuestion(request: PermissionRequest, t: Translations): string {
  const p = t.decisionCard.permission;
  const filePath = request.details.filePath || request.details.path;
  const target = filePath ? formatFilePath(filePath) : undefined;
  switch (request.type) {
    case 'file_read':
      return target ? p.questionFileRead.replace('{target}', target) : p.questionFallback;
    case 'file_write':
      return target ? p.questionFileWrite.replace('{target}', target) : p.questionFallback;
    case 'file_edit':
      return target ? p.questionFileEdit.replace('{target}', target) : p.questionFallback;
    case 'file_delete':
      return target ? p.questionFileDelete.replace('{target}', target) : p.questionFallback;
    case 'command':
      return p.questionCommand;
    case 'dangerous_command':
      return p.questionDangerousCommand;
    case 'network':
      return request.details.url
        ? p.questionNetwork.replace('{target}', request.details.url)
        : p.questionFallback;
    case 'mcp':
      return request.details.server && request.details.toolName
        ? p.questionMcp.replace('{target}', `${request.details.server} / ${request.details.toolName}`)
        : p.questionFallback;
    default:
      return p.questionFallback;
  }
}

export function PermissionCard() {
  const { t } = useI18n();
  const { pendingPermissionRequest, pendingPermissionSessionId, setPendingPermissionRequest } = useAppStore();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const { checkMemory, saveMemory } = usePermissionStore();
  const processedRequestRef = useRef<string | null>(null);
  // 选中的审批级别（DecisionCard 选项行）；字母快捷键直发时不经过它
  const [selectedLevel, setSelectedLevel] = useState<ApprovalLevel | null>(null);

  const request = pendingPermissionRequest && !(
    pendingPermissionSessionId &&
    currentSessionId &&
    pendingPermissionSessionId !== currentSessionId
  )
    ? normalizeRequest(pendingPermissionRequest)
    : null;

  // 新请求进来时清空选中态（ processedRequestRef 之外的生命周期，独立于记忆直发 ）
  const requestId = request?.id ?? null;
  useEffect(() => {
    setSelectedLevel(null);
  }, [requestId]);

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

  // 字母直发快捷键（点了就执行，不经确认键）— stopPropagation 防止触发 ChatView 的 Esc+Esc。
  // 数字键 1-N / Enter / Esc 由 DecisionCard 统一处理。
  useEffect(() => {
    if (!request) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 含 contentEditable（neo composer）：输入时不吃字母快捷键
      if (isEditableTarget(e.target)) {
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
          if (!hideStandingGrants) {
            e.preventDefault();
            e.stopPropagation();
            handleApproval('always');
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [request, handleApproval, hideStandingGrants]);

  // 如果没有当前会话可见的待处理权限请求，不渲染
  if (!request) return null;

  const config = getPermissionConfig(request.type);
  const dangerReason = isDangerous ? getDangerReason(request.details.command) : null;

  const p = t.decisionCard.permission;
  const options: DecisionOption[] = [
    { id: 'once', label: p.optionOnce, description: p.optionOnceDesc, shortcut: 'y' },
    ...(!hideStandingGrants
      ? [
          { id: 'session', label: p.optionSession, description: p.optionSessionDesc, shortcut: 's' },
          { id: 'always', label: p.optionAlways, description: p.optionAlwaysDesc, shortcut: 'a' },
        ]
      : []),
    { id: 'deny', label: p.optionDeny, description: p.optionDenyDesc, shortcut: 'n' },
  ];

  const reasonText = request.reason || (request.reasonCode ? permissionReasonText(request.reasonCode) : '');

  return (
    <DecisionCard
      testId="permission-card"
      tone={isDangerous ? 'danger' : 'neutral'}
      icon={config.icon}
      title={isDangerous ? t.decisionCard.dangerTitle : config.title}
      headerMeta={request.tool}
      dangerWarning={
        isDangerous
          ? `${t.decisionCard.dangerCopy}：${dangerReason || t.decisionCard.dangerDefaultReason}`
          : undefined
      }
      question={permissionQuestion(request, t)}
      details={
        <>
          {reasonText && <p className="text-zinc-400 text-sm">{reasonText}</p>}
          <RequestDetails request={request} />
        </>
      }
      options={options}
      selectedId={selectedLevel}
      onSelect={(id) => setSelectedLevel(id as ApprovalLevel)}
      onConfirm={() => {
        if (selectedLevel) void handleApproval(selectedLevel);
      }}
      onCancel={() => void handleApproval('deny')}
      confirmLabel={t.decisionCard.confirm}
      cancelLabel={p.optionDeny}
    />
  );
}
