// ============================================================================
// RoleWakeProposalsCard — 每日醒来「外部增量」巡检给出的一键工作提议
// 与首次醒来卡同位挂在专家主会话顶部（RoleFirstWakeThreadBanner）。点击 = 以提议
// prompt 在该专家会话开一轮对话（发送/写日历仍走审批）；「先不」= 搁置期内不再出现。
// ============================================================================
import React, { useEffect, useState } from 'react';
import type { RoleWakeProposal } from '@shared/contract/roleAssets';
import { useI18n } from '../../../hooks/useI18n';
import { DomainInvokeError } from '../../../services/ipcService';
import { acceptWakeProposal, dismissWakeProposal, getFirstWake, listWakeProposals } from '../../../services/rolesClient';
import { useAppStore } from '../../../stores/appStore';
import { goToExpertThread } from '../../../utils/inviteExpert';

interface RoleWakeProposalsCardProps {
  roleId: string;
  /** 包一层会话顶部的栏宽（与 RoleFirstWakeCard.framed 同款）。 */
  framed?: boolean;
}

export const RoleWakeProposalsCard: React.FC<RoleWakeProposalsCardProps> = ({ roleId, framed = false }) => {
  const { t } = useI18n();
  const copy = t.roleWakeProposals;
  const firstWakeCardRoleId = useAppStore((state) => state.firstWakeCardRoleId);
  const [proposals, setProposals] = useState<RoleWakeProposal[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 首次醒来卡片可见时不出现（2026-11-05 owner 返修 A）：只允许无首次醒来卡时渲染
    // （firstWake 为 null 或已 skipped），避免两套建议和「先不用 / 先不」同时竞争。
    void Promise.all([listWakeProposals(roleId), getFirstWake(roleId)])
      .then(([next, wake]) => {
        if (cancelled) return;
        const firstWakeVisible = wake !== null && wake !== undefined && wake.state !== 'skipped';
        setProposals(firstWakeVisible ? [] : next);
      })
      .catch(() => { if (!cancelled) setProposals([]); });
    return () => { cancelled = true; };
  }, [roleId, firstWakeCardRoleId]);

  if (firstWakeCardRoleId === roleId || proposals === null || proposals.length === 0) return null;

  const remove = (title: string): void => {
    setProposals((prev) => (prev ?? []).filter((p) => p.title !== title));
  };

  const handleAccept = async (proposal: RoleWakeProposal): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const accepted = await acceptWakeProposal(roleId, proposal.title);
      if (!accepted) {
        // 已不在 pending（别处点过）：同步本地状态即可
        remove(proposal.title);
        return;
      }
      remove(proposal.title);
      await goToExpertThread(roleId, { seed: accepted.prompt });
    } catch (error) {
      // 宿主对已不在 pending 返回 NOT_FOUND。invokeDomain 抛 DomainInvokeError，不是 null。
      // 这是预期缺席：卡片消失，不开新一轮。其它错误继续抛出。
      if (error instanceof DomainInvokeError && error.code === 'NOT_FOUND') {
        remove(proposal.title);
        return;
      }
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = async (proposal: RoleWakeProposal): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await dismissWakeProposal(roleId, proposal.title);
      remove(proposal.title);
    } finally {
      setBusy(false);
    }
  };

  // 与 RoleFirstWakeCard 同一视觉语言（role-wake-prototype.html 屏一）：无填充面板、
  // 安静的描边按钮 + 淡的「先不」，颜色全走主题 token。mb-2 mt-2 同款间距语义。
  const body = (
    <div
      className="mb-2 mt-2"
      data-testid="role-wake-proposals-card"
    >
      <p className="text-sm text-text-tertiary">{copy.heading}</p>
      <div className="mt-2 space-y-1.5">
        {proposals.map((proposal) => (
          <div key={proposal.title} className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              className="rounded-lg border border-border-strong bg-void px-3 py-1.5 text-left text-sm font-normal text-text-secondary transition-colors hover:border-border-hover hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => { void handleAccept(proposal); }}
            >
              {proposal.title}
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-md px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => { void handleDismiss(proposal); }}
            >
              {copy.dismiss}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
  if (!framed) return body;
  return (
    <div className="chat-col-pad mt-2">
      <div className="mx-auto w-full max-w-3xl">{body}</div>
    </div>
  );
};
