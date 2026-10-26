// ============================================================================
// RoleWakeProposalsCard — 每日醒来「外部增量」巡检给出的一键工作提议
// 与首次醒来卡同位挂在专家主会话顶部（RoleFirstWakeThreadBanner）。点击 = 以提议
// prompt 在该专家会话开一轮对话（发送/写日历仍走审批）；「先不」= 搁置期内不再出现。
// ============================================================================
import React, { useEffect, useState } from 'react';
import type { RoleWakeProposal } from '@shared/contract/roleAssets';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { DomainInvokeError } from '../../../services/ipcService';
import { acceptWakeProposal, dismissWakeProposal, listWakeProposals } from '../../../services/rolesClient';
import { goToExpertThread } from '../../../utils/inviteExpert';

interface RoleWakeProposalsCardProps {
  roleId: string;
  /** 包一层会话顶部的栏宽（与 RoleFirstWakeCard.framed 同款）。 */
  framed?: boolean;
}

export const RoleWakeProposalsCard: React.FC<RoleWakeProposalsCardProps> = ({ roleId, framed = false }) => {
  const { t } = useI18n();
  const copy = t.roleWakeProposals;
  const [proposals, setProposals] = useState<RoleWakeProposal[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listWakeProposals(roleId)
      .then((next) => { if (!cancelled) setProposals(next); })
      .catch(() => { if (!cancelled) setProposals([]); });
    return () => { cancelled = true; };
  }, [roleId]);

  if (proposals === null || proposals.length === 0) return null;

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

  const body = (
    <div
      className="mb-2 rounded-lg border border-badge-info/60 bg-sky-950/30 px-3 py-2"
      data-testid="role-wake-proposals-card"
    >
      <p className="text-xs text-zinc-200">{copy.heading}</p>
      <div className="mt-2 space-y-1.5">
        {proposals.map((proposal) => (
          <div key={proposal.title} className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              className="h-auto whitespace-normal text-left"
              onClick={() => { void handleAccept(proposal); }}
            >
              {proposal.title}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="h-auto"
              onClick={() => { void handleDismiss(proposal); }}
            >
              {copy.dismiss}
            </Button>
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
