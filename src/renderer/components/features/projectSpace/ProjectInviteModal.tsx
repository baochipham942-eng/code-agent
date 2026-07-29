// ============================================================================
// ProjectInviteModal —— 空间邀请码弹层：展示 createInvite 新建的邀请码 + 一键复制。
// 复制走 navigator.clipboard，失败降级为选中输入框文本 + toast 提示手动复制。
// 状态全部来自 useProjectSpaceInvite（页头按钮与成员卡共用同一实例）。
// ============================================================================

import React, { useRef, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { SecondaryButton } from '../../primitives/Button';
import { Input } from '../../primitives/Input';
import { Modal } from '../../primitives/Modal';
import { INVITE_EXPIRES_IN_HOURS, INVITE_MAX_USES, type ProjectSpaceInviteState } from './useProjectSpaceInvite';

export interface ProjectInviteModalProps {
  state: ProjectSpaceInviteState;
  isOpen: boolean;
  onClose: () => void;
}

export const ProjectInviteModal: React.FC<ProjectInviteModalProps> = ({ state, isOpen, onClose }) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const codeInputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const copyCode = async (code: string) => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 降级：选中输入框文本，toast 提示手动复制（不吞错）
      codeInputRef.current?.select();
      toast.error(ps.copyFailed);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={ps.inviteTitle} size="sm">
      <div className="grid gap-3" data-testid="project-space-invite-modal">
        {state.status === 'loading' || state.status === 'idle' ? (
          <p className="py-4 text-center text-sm text-zinc-500" data-testid="project-space-invite-loading">
            {ps.inviteCreating}
          </p>
        ) : state.status === 'error' ? (
          <p className="py-4 text-center text-sm text-red-400" data-testid="project-space-invite-error">
            {ps.inviteFailed}: {state.error}
          </p>
        ) : state.invite ? (
          <>
            <div className="flex gap-2">
              <Input
                ref={codeInputRef}
                readOnly
                value={state.invite.code}
                data-testid="project-space-invite-code"
                onFocus={(event) => event.target.select()}
              />
              <SecondaryButton
                size="sm"
                className="shrink-0"
                data-testid="project-space-invite-copy"
                onClick={() => { void copyCode(state.invite!.code); }}
              >
                {copied ? ps.copied : ps.copy}
              </SecondaryButton>
            </div>
            <p className="text-xs text-zinc-500" data-testid="project-space-invite-hint">
              {ps.inviteHint
                .replace('{hours}', String(INVITE_EXPIRES_IN_HOURS))
                .replace('{uses}', String(INVITE_MAX_USES))}
            </p>
          </>
        ) : null}
      </div>
    </Modal>
  );
};
