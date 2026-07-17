// ============================================================================
// RoleDraftCard - 对话式建角色草稿确认卡（role-creation-flow）
// propose_role 工具起草后发 role_draft_pending 事件，在输入框上方弹确认卡。
// 草稿严禁自动入库：只有用户点"确认创建"才会写 agents/<id>.md + 建 roles/<id>/。
// 镜像 SkillDraftCard 范式。
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { UserPlus, Check, X, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import ipcService from '../../../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';

export interface RoleDraftSummary {
  id: string;
  roleId: string;
  description: string;
  category?: string;
  tools: string[];
  /** 有值 = 改已有角色（确认卡切「确认修改」文案；缺省 = 新建） */
  editingRoleId?: string;
}

/**
 * 自包含的草稿通知容器：订阅 agent:event 里的 role_draft_pending 事件，
 * 有待确认草稿时渲染确认卡片。ChatInput 只需挂载 <RoleDraftNotifications />。
 */
export const RoleDraftNotifications: React.FC = () => {
  const [drafts, setDrafts] = useState<RoleDraftSummary[]>([]);

  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: { type: string; data: unknown }) => {
      if (event.type !== 'role_draft_pending' || !event.data) return;
      const payload = event.data as { drafts?: RoleDraftSummary[] };
      if (!Array.isArray(payload.drafts) || payload.drafts.length === 0) return;
      setDrafts((prev) => {
        // 同名草稿（重新起草）替换旧的，保证卡片展示的是最新定义
        const incoming = payload.drafts as RoleDraftSummary[];
        const incomingRoleIds = new Set(incoming.map((d) => d.roleId));
        const kept = prev.filter((d) => !incomingRoleIds.has(d.roleId));
        return [...kept, ...incoming];
      });
    });
    return () => { unsubscribe?.(); };
  }, []);

  if (drafts.length === 0) return null;

  return (
    <RoleDraftCard
      drafts={drafts}
      onResolved={(draftId) => setDrafts((prev) => prev.filter((draft) => draft.id !== draftId))}
      onDismiss={() => setDrafts([])}
    />
  );
};

interface RoleDraftCardProps {
  drafts: RoleDraftSummary[];
  onResolved: (draftId: string) => void;
  onDismiss: () => void;
}

export const RoleDraftCard: React.FC<RoleDraftCardProps> = ({ drafts, onResolved, onDismiss }) => {
  const { t } = useI18n();
  const r = t.roleDraft;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<Record<string, string>>({});

  const handleConfirm = async (draftId: string) => {
    const isEdit = Boolean(drafts.find((d) => d.id === draftId)?.editingRoleId);
    const verb = isEdit ? r.verbEdit : r.verbCreate;
    setBusyId(draftId);
    try {
      const result = await ipcService.invokeDomain<{ success?: boolean; roleId?: string }>(
        IPC_DOMAINS.ROLES,
        'confirmDraft',
        { draftId },
      );
      if (result?.success) {
        onResolved(draftId);
        toast.success(`${r.updatedToastPrefix}${result.roleId ?? ''}${r.updatedToastSuffix}${verb}`);
      } else {
        toast.error(`${r.actionFailedPrefix}${verb}${r.actionFailedSuffix}`);
      }
    } catch (error) {
      // 安全闸拦截 / 重名等会走到这里，把后端原因透出
      toast.error(error instanceof Error ? error.message : `${r.actionFailedPrefix}${verb}${r.actionFailedSuffix}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (draftId: string) => {
    setBusyId(draftId);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.ROLES, 'rejectDraft', { draftId });
      onResolved(draftId);
      toast.info(r.discardedToast);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : r.processFailedToast);
    } finally {
      setBusyId(null);
    }
  };

  // 展开"查看完整定义"时懒加载 system prompt（listDrafts 返回完整草稿）
  const toggleExpand = useCallback(async (draftId: string) => {
    if (expandedId === draftId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(draftId);
    if (definitions[draftId] === undefined) {
      try {
        const list = await ipcService.invokeDomain<Array<{ id: string; systemPrompt?: string }>>(
          IPC_DOMAINS.ROLES,
          'listDrafts',
        );
        const found = list?.find((d) => d.id === draftId);
        setDefinitions((prev) => ({ ...prev, [draftId]: found?.systemPrompt ?? r.definitionUnavailable }));
      } catch {
        setDefinitions((prev) => ({ ...prev, [draftId]: r.definitionUnavailable }));
      }
    }
  }, [expandedId, definitions, r.definitionUnavailable]);

  if (drafts.length === 0) return null;

  return (
    <div className="px-3 py-2 mb-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg animate-fadeIn">
      <div className="flex items-center gap-2 mb-1">
        <UserPlus className="w-4 h-4 text-emerald-400 flex-shrink-0" />
        <span className="text-xs text-emerald-300 flex-1">
          {drafts.some((d) => d.editingRoleId)
            ? r.pendingEditBanner
            : r.pendingCreateBanner}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
          title={r.laterTitle}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {drafts.map((draft) => {
        const expanded = expandedId === draft.id;
        const toolsLine = draft.tools.length > 0 ? draft.tools.join('、') : r.defaultToolsFallback;
        const isEdit = Boolean(draft.editingRoleId);
        return (
          <div key={draft.id} className="py-1">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {isEdit && (
                    <span className="px-1.5 py-px text-[10px] rounded bg-amber-500/20 text-amber-300 flex-shrink-0">
                      {r.editBadge}
                    </span>
                  )}
                  <span className="text-xs font-medium text-emerald-100 truncate" title={draft.roleId}>
                    {draft.roleId}
                  </span>
                  {draft.category && (
                    <span className="px-1.5 py-px text-[10px] rounded bg-emerald-500/20 text-emerald-300 flex-shrink-0">
                      {draft.category}
                    </span>
                  )}
                </div>
                {draft.description && (
                  <div className="text-[11px] text-emerald-200/70 truncate" title={draft.description}>
                    {draft.description}
                  </div>
                )}
                {/* 权限面：确认前必须让用户看清这角色拿到哪些能力（设计 §8 安全） */}
                <div className="text-[11px] text-emerald-200/50 truncate" title={toolsLine}>
                  {r.capabilityPrefix}{toolsLine}
                </div>
              </div>

              <button
                type="button"
                onClick={() => handleConfirm(draft.id)}
                disabled={busyId !== null}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-emerald-500/20 text-emerald-300 rounded hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
              >
                {busyId === draft.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                {isEdit ? r.confirmEdit : r.confirmCreate}
              </button>

              <button
                type="button"
                onClick={() => handleReject(draft.id)}
                disabled={busyId !== null}
                className="px-2 py-1 text-xs text-zinc-400 rounded hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors disabled:opacity-50"
              >
                {r.discard}
              </button>
            </div>

            <button
              type="button"
              onClick={() => toggleExpand(draft.id)}
              className="flex items-center gap-0.5 mt-0.5 text-[11px] text-emerald-300/70 hover:text-emerald-200 transition-colors"
            >
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {r.viewFullDefinition}
            </button>
            {expanded && (
              <pre className="mt-1 p-2 text-[11px] text-emerald-100/80 bg-black/20 rounded max-h-48 overflow-auto whitespace-pre-wrap break-words">
                {definitions[draft.id] ?? r.loadingDefinition}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
};
