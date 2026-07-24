// ============================================================================
// SkillDraftCard - Skill 草稿确认卡片（GAP-005 半自动蒸馏）
// 经验沉淀管线在 session 结束时蒸馏出 skill 草稿后，在输入框上方弹确认。
// 草稿严禁自动入库：只有用户点"采纳"才会移入 skills 目录。
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useComposerNoticeStore } from '../../../../stores/composerNoticeStore';
import { FlaskConical, Check, X, Loader2 } from 'lucide-react';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';
import type { Translations } from '../../../../i18n/zh';
import type { SkillDraftOrigin } from '../../../../../shared/contract/agent';

export interface SkillDraftSummary {
  id: string;
  name: string;
  description: string;
  toolSequence: string[];
  occurrences: number;
  /** 来源：缺省按经验蒸馏处理（兼容旧事件） */
  origin?: SkillDraftOrigin;
}

/** 来源徽标文案 + 配色（区分 telemetry 经验蒸馏 vs LLM 自沉淀） */
function originBadge(t: Translations, origin?: SkillDraftOrigin): { label: string; className: string } {
  return origin === 'llm-review'
    ? { label: t.skillDraft.originLlm, className: 'bg-violet-500/20 text-violet-300' }
    : { label: t.skillDraft.originTelemetry, className: 'bg-sky-500/20 text-sky-300' };
}

/**
 * 自包含的草稿通知容器：自己订阅 agent:event 里的 skill_draft_pending 事件，
 * 有待确认草稿时渲染确认卡片。ChatInput 只需要挂载 <SkillDraftNotifications />。
 */
export const SkillDraftNotifications: React.FC = () => {
  const [drafts, setDrafts] = useState<SkillDraftSummary[]>([]);

  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: { type: string; data: unknown }) => {
      if (event.type !== 'skill_draft_pending' || !event.data) return;
      const payload = event.data as { drafts?: SkillDraftSummary[] };
      if (!Array.isArray(payload.drafts) || payload.drafts.length === 0) return;
      setDrafts((prev) => {
        const known = new Set(prev.map((draft) => draft.id));
        return [...prev, ...(payload.drafts as SkillDraftSummary[]).filter((draft) => !known.has(draft.id))];
      });
    });
    return () => { unsubscribe?.(); };
  }, []);

  // 确认卡是阻塞性决策，占住输入框上方那一格（成员条会据此收成极窄摘要）
  useEffect(() => {
    const setNotice = useComposerNoticeStore.getState().setNotice;
    setNotice('skill-draft', drafts.length > 0);
    return () => setNotice('skill-draft', false);
  }, [drafts.length]);

  if (drafts.length === 0) return null;

  return (
    <SkillDraftCard
      drafts={drafts}
      onResolved={(draftId) => setDrafts((prev) => prev.filter((draft) => draft.id !== draftId))}
      onDismiss={() => setDrafts([])}
    />
  );
};

interface SkillDraftCardProps {
  drafts: SkillDraftSummary[];
  onResolved: (draftId: string) => void;
  onDismiss: () => void;
}

const invokeSkillDraft = async <T,>(channel: string, ...args: unknown[]): Promise<T | undefined> => {
  return (ipcService.invoke as (...a: unknown[]) => Promise<T>)(channel, ...args);
};

export const SkillDraftCard: React.FC<SkillDraftCardProps> = ({
  drafts,
  onResolved,
  onDismiss,
}) => {
  const { t } = useI18n();
  const s = t.skillDraft;
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleConfirm = async (draftId: string) => {
    setBusyId(draftId);
    try {
      const result = await invokeSkillDraft<{ success: boolean }>('skill:draft:confirm', draftId);
      if (result?.success) {
        onResolved(draftId);
        toast.success(s.savedToast);
      } else {
        toast.error(s.acceptFailedToast);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : s.acceptFailedToast);
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (draftId: string) => {
    setBusyId(draftId);
    try {
      await invokeSkillDraft<{ success: boolean }>('skill:draft:reject', draftId);
      onResolved(draftId);
      toast.info(s.discardedToast);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : s.processFailedToast);
    } finally {
      setBusyId(null);
    }
  };

  if (drafts.length === 0) return null;

  return (
    <div className="px-3 py-2 mb-2 bg-sky-500/10 border border-sky-500/20 rounded-lg animate-fadeIn">
      <div className="flex items-center gap-2 mb-1">
        <FlaskConical className="w-4 h-4 text-sky-400 flex-shrink-0" />
        <span className="text-xs text-sky-300 flex-1">
          {s.bannerPrefix}{drafts.length}{s.bannerSuffix}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
          title={s.laterTitle}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {drafts.map((draft) => {
        const badge = originBadge(t, draft.origin);
        // LLM 自沉淀草稿没有工具序列，副标题展示描述；经验蒸馏展示工具序列 + 成功次数
        const subtitle = draft.origin === 'llm-review'
          ? draft.description
          : `${draft.toolSequence.join(' → ')}${s.subtitleSuffix.replace('{n}', String(draft.occurrences))}`;
        return (
        <div key={draft.id} className="flex items-center gap-2 py-1">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`px-1.5 py-px text-[10px] rounded flex-shrink-0 ${badge.className}`}>
                {badge.label}
              </span>
              <span className="text-xs text-sky-200 truncate" title={draft.name}>
                {draft.name}
              </span>
            </div>
            <div className="text-[11px] text-sky-200/60 truncate" title={subtitle}>
              {subtitle}
            </div>
          </div>

          <button
            type="button"
            onClick={() => handleConfirm(draft.id)}
            disabled={busyId !== null}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-sky-500/20 text-sky-300 rounded hover:bg-sky-500/30 transition-colors disabled:opacity-50"
          >
            {busyId === draft.id ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Check className="w-3 h-3" />
            )}
            {s.accept}
          </button>

          <button
            type="button"
            onClick={() => handleReject(draft.id)}
            disabled={busyId !== null}
            className="px-2 py-1 text-xs text-zinc-400 rounded hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors disabled:opacity-50"
          >
            {s.reject}
          </button>
        </div>
        );
      })}
    </div>
  );
};
