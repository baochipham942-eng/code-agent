// ============================================================================
// PermissionCard - DecisionSlot 当前待决权限的卡片
// 固定在 ChatInput 上方；裁决后由对应工具步骤展示一行结果，不生成时间线历史卡
//
// 2026-07-29 拍板：视觉骨架统一迁移到 DecisionCard（与 AskUserQuestion 提问卡
// 同形）——审批级别变成选项行，底部 ghost 取消 + primary 确认（选中后才可点）。
// 数据流/store/IPC 不变；y/n/s/a 字母快捷键保留直发（点了就执行，不经确认键），
// Shift+N=永不允许 作为隐藏直发保留；授权记忆命中仍 100ms 自动执行、不弹卡。
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarPlus, ListTodo, Mail } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePermissionStore, type PermissionRequestForMemory } from '../../stores/permissionStore';
import { DecisionCard, isEditableTarget, type DecisionCardViewMode, type DecisionOption } from '../DecisionCard';
import { RequestDetails } from './RequestDetails';
import type { PermissionRequest, ApprovalLevel, PermissionType } from './types';
import type { PermissionRequest as ContractPermissionRequest, PermissionResponse } from '@shared/contract';
import { isEditableTool } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { getPermissionConfig, isDangerousCommand } from './utils';
import { useI18n } from '../../hooks/useI18n';
import ipcService from '../../services/ipcService';
import { toast } from '../../hooks/useToast';
import { claimApprovalResponse, releaseApprovalResponse } from '../../utils/approvalResponseGuard';
import {
  WritebackEditForm,
  draftFromArgs,
  draftMissingRequired,
  draftToArgs,
  type WritebackDraft,
} from './WritebackFields';
import { defaultPermissionViewMode, permissionSummary } from './permissionPresentation';

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
      commandRiskLevel: request.details.commandRiskLevel,
      commandSecurityFlags: request.details.commandSecurityFlags,
      affectedPath: request.details.affectedPath,
      affectedFileCount: request.details.affectedFileCount,
      path: request.details.path,
      preview: request.details.preview,
    },
    // 可编辑工具才带原参数（host 默认分支 details = {...params} + 透传字段）；其余不背这份
    rawArgs: isEditableTool(request.tool) ? (request.details as Record<string, unknown>) : undefined,
    timestamp: request.timestamp,
    decisionTrace: request.decisionTrace,
    resolved: request.resolved,
    decision: request.decision,
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

interface PermissionCardProps {
  requestOverride?: ContractPermissionRequest;
  sessionIdOverride?: string | null;
  remainingCount?: number;
  onCollapse?: () => void;
}

export function PermissionCard({
  requestOverride,
  sessionIdOverride,
  remainingCount = 0,
  onCollapse,
}: PermissionCardProps = {}) {
  const { t } = useI18n();
  const {
    pendingPermissionRequest,
    pendingPermissionSessionId,
    setPendingPermissionRequest,
    recordPermissionDecision,
  } = useAppStore();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const { checkMemory, saveMemory } = usePermissionStore();
  const processedRequestRef = useRef<string | null>(null);
  // 选中的审批级别（DecisionCard 选项行）；字母快捷键直发时不经过它
  const [selectedLevel, setSelectedLevel] = useState<ApprovalLevel | null>('once');
  // N-WRITEBACK-EDIT 编辑态：draft 非 null = 正在改；只有点「按修改后发送」才会送出，Esc/放弃 = 什么都不发
  const [draft, setDraft] = useState<WritebackDraft | null>(null);
  const [viewState, setViewState] = useState<{ requestId: string; mode: DecisionCardViewMode } | null>(null);

  const sourceRequest = requestOverride ?? pendingPermissionRequest;
  const sourceSessionId = requestOverride ? sessionIdOverride : pendingPermissionSessionId;
  const request = sourceRequest && !(
    sourceSessionId &&
    currentSessionId &&
    sourceSessionId !== currentSessionId
  )
    ? normalizeRequest(sourceRequest)
    : null;
  const settled = request?.resolved === true && request.decision !== undefined;

  // 新请求进来时清空选中态（ processedRequestRef 之外的生命周期，独立于记忆直发 ）
  const requestId = request?.id ?? null;
  useEffect(() => {
    setSelectedLevel('once');
    setDraft(null);
  }, [requestId]);

  // 可编辑写回工具：三选一（原样写回 / 改一改再写回 / 取消），永远一次性放行
  const editable = request?.rawArgs !== undefined && isEditableTool(request.tool);
  const isMeetingCreate = request?.tool === 'tmeetMeetingCreate';
  const isCalendarWrite = request?.tool === 'calendar_create_event' || request?.tool === 'calendar_update_event';
  const isRemindersWrite = request?.tool === 'reminders_create' || request?.tool === 'reminders_update';
  const isNativeCreate = request?.tool === 'calendar_create_event' || request?.tool === 'reminders_create';
  const isNativeUpdate = request?.tool === 'calendar_update_event' || request?.tool === 'reminders_update';

  // 「这操作本身危险」与「这次必须你亲手点」是两件事，卡上必须分开表达。
  //
  // host 侧的 forceConfirm 同时被两个来源置位：confirmationGate 的真风险评估
  // （它另外还给出 dangerLevel），和 readOnly / 通话抬严这类**流程性**要求
  // （档位规定逐次确认，与内容危险度无关）。此前这里把 forceConfirm 直接当危险，
  // 于是往工作目录写个 hello 也会顶着红框和「这是一个危险命令」——
  // 红卡成了常态，真危险那次反而淹在里面。
  // 可编辑写回工具不走「危险命令」红卡：它的风险是「发出去收不回」，用黄色不可撤回提示表达，
  // host 侧 risk=high 判定不动（它还管停车/账本）。
  const isDangerous =
    request !== null &&
    !editable &&
    (request.dangerLevel === 'danger' ||
      request.type === 'dangerous_command' ||
      (request.type === 'command' && isDangerousCommand(request.details.command)));

  // forceConfirm 该有的职责一点没松：不许走「会话/始终」这类常驻授权，必须逐次点。
  const hideStandingGrants = isDangerous || editable || request?.forceConfirm === true;

  const memoryRequest = request ? toMemoryRequest(request) : null;
  const isNewRequest = request !== null && !settled && processedRequestRef.current !== request.id;
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
    async (level: ApprovalLevel, updatedArgs?: Record<string, unknown>) => {
      if (!request || settled) return;

      const requestSnapshot = requestOverride ?? pendingPermissionRequest;
      const requestSessionId = requestOverride ? sessionIdOverride ?? null : pendingPermissionSessionId;
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
        // 改过的参数只随 'allow' 一次性放行送出（host 侧同样只认这个组合）
        await ipcService.invoke(
          IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
          request.id,
          response,
          request.sessionId,
          ...(updatedArgs && response === 'allow' ? [updatedArgs] : []),
        );
        if (requestSnapshot && recordPermissionDecision) {
          recordPermissionDecision(
            updatedArgs
              ? { ...requestSnapshot, details: { ...requestSnapshot.details, ...updatedArgs } }
              : requestSnapshot,
            level,
            requestSessionId,
          );
        } else if (!requestOverride) {
          setPendingPermissionRequest(null);
        }
      } catch {
        processedRequestRef.current = null;
        releaseApprovalResponse(request.id);
        if (!requestOverride) {
          setPendingPermissionRequest(requestSnapshot, requestSessionId);
        }
        toast.error('审批响应发送失败，请重试');
      }
    },
    [
      pendingPermissionRequest,
      pendingPermissionSessionId,
      requestOverride,
      sessionIdOverride,
      request?.id,
      request?.sessionId,
      request?.forceConfirm,
      request?.tool,
      request?.type,
      request?.details,
      saveMemory,
      settled,
      recordPermissionDecision,
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
    if (!request || settled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 含 contentEditable（neo composer）：输入时不吃字母快捷键
      if (isEditableTarget(e.target)) {
        return;
      }
      // 编辑态里字母直发一律停掉：改到一半按个 y 把原稿发出去 = 与编辑态的承诺相反
      if (draft !== null) return;

      const key = e.key.toLowerCase();

      switch (key) {
        case 'e':
          if (editable && request.rawArgs) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(draftFromArgs(request.tool, request.rawArgs));
          }
          break;
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
  }, [request, settled, handleApproval, hideStandingGrants, draft, editable]);

  // 如果没有当前会话可见的待处理权限请求，不渲染
  if (!request) return null;

  const config = getPermissionConfig(request.type);

  const p = t.decisionCard.permission;
  const w = p.writeback;
  const pendingHeaderEnd = remainingCount > 0
    ? <span className="text-xs text-zinc-500">{p.remainingCount.replace('{count}', String(remainingCount))}</span>
    : undefined;
  const options: DecisionOption[] = editable ? [
    {
      id: 'once',
      label: isMeetingCreate ? w.optionCreate : isNativeCreate ? w.optionCreateItem : isNativeUpdate ? w.optionUpdate : w.optionSend,
      description: isMeetingCreate ? w.optionCreateDesc : isNativeCreate ? w.optionCreateItemDesc : isNativeUpdate ? w.optionUpdateDesc : w.optionSendDesc,
      shortcut: 'y',
    },
    {
      id: 'edit',
      label: isMeetingCreate ? w.optionEditMeeting : isNativeCreate ? w.optionEditCreate : isNativeUpdate ? w.optionEditUpdate : w.optionEdit,
      description: isMeetingCreate ? w.optionEditMeetingDesc : isNativeCreate ? w.optionEditCreateDesc : isNativeUpdate ? w.optionEditUpdateDesc : w.optionEditDesc,
      shortcut: 'e',
    },
    {
      id: 'deny',
      label: isMeetingCreate ? w.optionDenyMeeting : isNativeCreate ? w.optionDenyCreate : isNativeUpdate ? w.optionDenyUpdate : w.optionDeny,
      description: isMeetingCreate ? w.optionDenyMeetingDesc : isNativeCreate ? w.optionDenyCreateDesc : isNativeUpdate ? w.optionDenyUpdateDesc : w.optionDenyDesc,
      shortcut: 'n',
    },
  ] : [
    { id: 'once', label: p.optionOnce, description: p.optionOnceDesc, shortcut: 'y' },
    ...(!hideStandingGrants
      ? [
          { id: 'session', label: p.optionSession, description: p.optionSessionDesc, shortcut: 's' },
          { id: 'always', label: p.optionAlways, description: p.optionAlwaysDesc, shortcut: 'a' },
        ]
      : []),
    { id: 'deny', label: p.optionDeny, description: p.optionDenyDesc, shortcut: 'n' },
  ];

  // 可编辑写回工具的专属呈现：标题 / 图标 / 问句点题（不再是「创建文件」+「允许这次操作？」）
  const firstRecipient = editable && Array.isArray(request.rawArgs?.to) ? String(request.rawArgs.to[0] ?? '') : '';
  const meetingSubject = isMeetingCreate && typeof request.rawArgs?.subject === 'string'
    ? request.rawArgs.subject.trim()
    : '';
  const contentTitle = editable && typeof request.rawArgs?.title === 'string'
    ? request.rawArgs.title.trim()
    : '';
  const title = isMeetingCreate
    ? w.tmeetCreateTitle
    : request.tool === 'calendar_create_event'
      ? w.calendarCreateTitle
      : request.tool === 'calendar_update_event'
        ? w.calendarUpdateTitle
        : request.tool === 'reminders_create'
          ? w.remindersCreateTitle
          : request.tool === 'reminders_update'
            ? w.remindersUpdateTitle
            : editable ? w.mailSendTitle : (isDangerous ? getPermissionConfig('command').title : config.title);
  const icon = isMeetingCreate || isCalendarWrite
    ? <CalendarPlus size={20} />
    : isRemindersWrite
      ? <ListTodo size={20} />
      : editable ? <Mail size={20} /> : config.icon;
  const question = isMeetingCreate
    ? (meetingSubject ? w.tmeetCreateQuestion.replace('{subject}', meetingSubject) : w.tmeetCreateQuestionFallback)
    : request.tool === 'calendar_create_event'
      ? (contentTitle ? w.calendarCreateQuestion.replace('{title}', contentTitle) : w.calendarCreateQuestionFallback)
      : request.tool === 'calendar_update_event'
        ? (contentTitle ? w.calendarUpdateQuestion.replace('{title}', contentTitle) : w.calendarUpdateQuestionFallback)
        : request.tool === 'reminders_create'
          ? (contentTitle ? w.remindersCreateQuestion.replace('{title}', contentTitle) : w.remindersCreateQuestionFallback)
          : request.tool === 'reminders_update'
            ? (contentTitle ? w.remindersUpdateQuestion.replace('{title}', contentTitle) : w.remindersUpdateQuestionFallback)
    : editable
    ? (firstRecipient ? w.mailSendQuestion.replace('{target}', firstRecipient) : w.mailSendQuestionFallback)
    : permissionSummary(request, t);
  const viewMode = viewState?.requestId === request.id
    ? viewState.mode
    : defaultPermissionViewMode(request);
  const headerEnd = isDangerous || pendingHeaderEnd ? (
    <span className="flex items-center gap-2">
      {isDangerous && (
        <span className="rounded-full border border-red-500/35 bg-red-500/10 px-2 py-0.5 text-[10px] text-badge-danger">
          {t.decisionCard.dangerBadge}
        </span>
      )}
      {pendingHeaderEnd}
    </span>
  ) : undefined;
  const visibleOptions: DecisionOption[] = isDangerous
    ? [
        { id: 'once', label: t.decisionCard.stillExecute, shortcut: 'y' },
        { id: 'deny', label: p.optionDeny, shortcut: 'n' },
      ]
    : options;

  // 已决请求不再由 PermissionCard 渲染；结果归属到对应工具步骤旁的一行存证。
  if (settled) return null;

  // 编辑态：选项行让位给表单；主按钮 = 按修改后发送（必填为空时禁用），ghost = 放弃修改
  if (editable && draft !== null && request.rawArgs) {
    const missing = draftMissingRequired(request.tool, draft);
    return (
      <DecisionCard
        testId="permission-card"
        className="w-full animate-slideUp"
        pinActions
        viewMode="expanded"
        tone="amber"
        icon={icon}
        title={title}
        headerMeta={w.editingBadge}
        headerEnd={pendingHeaderEnd}
        question={isMeetingCreate
          ? w.tmeetWriteWarning
          : isCalendarWrite
            ? w.calendarWriteWarning
            : isRemindersWrite ? w.remindersWriteWarning : w.irreversible}
        details={
          <WritebackEditForm
            tool={request.tool}
            draft={draft}
            original={request.rawArgs}
            onChange={setDraft}
          />
        }
        options={[]}
        selectedId={missing.length === 0 ? 'edit' : null}
        onSelect={() => {}}
        onConfirm={() => {
          if (missing.length === 0) void handleApproval('once', draftToArgs(request.tool, draft));
        }}
        onCollapse={onCollapse}
        enterDisabled
        onCancel={() => setDraft(null)}
        cancelLabel={w.discard}
        confirmLabel={isMeetingCreate || isNativeCreate ? w.createEdited : isNativeUpdate ? w.updateEdited : w.sendEdited}
      />
    );
  }

  return (
    <DecisionCard
      testId="permission-card"
      className="w-full animate-slideUp"
      pinActions
      tone={isDangerous ? 'danger' : 'amber'}
      icon={icon}
      title={title}
      headerEnd={headerEnd}
      question={question}
      details={
        <>
          <RequestDetails request={request} />
        </>
      }
      options={visibleOptions}
      selectedId={selectedLevel}
      onSelect={(id) => {
        if (id === 'edit') {
          if (request.rawArgs) setDraft(draftFromArgs(request.tool, request.rawArgs));
          return;
        }
        setSelectedLevel(id as ApprovalLevel);
      }}
      onConfirm={() => {
        if (selectedLevel) void handleApproval(selectedLevel);
      }}
      onCollapse={onCollapse}
      enterDisabled={isDangerous || editable}
      viewMode={viewMode}
      onViewModeChange={(mode) => setViewState({ requestId: request.id, mode })}
      expandLabel={t.decisionCard.details}
      collapseLabel={t.decisionCard.collapse}
      directActions
      primaryActionId={isDangerous ? 'deny' : 'once'}
      dangerActionId={isDangerous ? 'once' : undefined}
      onDirectAction={(id) => {
        if (id === 'edit') {
          if (request.rawArgs) setDraft(draftFromArgs(request.tool, request.rawArgs));
          return;
        }
        void handleApproval(id as ApprovalLevel);
      }}
      confirmLabel={t.decisionCard.confirm}
    />
  );
}
