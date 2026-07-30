// ============================================================================
// useProjectSpaceInvite —— 空间邀请码 Modal 的共享状态（页头「邀请」按钮与右栏成员卡
// 「邀请」入口共用，同一份 createInvite 逻辑不复制两份）。
// 打开即新建邀请码（后端无 list 接口，Modal 每次新建）；有效期/次数写死常量不散数字。
// 失败 toast 真因（host error.message 已是人话），同时留 error 态给 Modal 内展示。
// ============================================================================

import { useCallback, useState } from 'react';
import type { ProjectInvite } from '@shared/contract/project';
import { createInvite } from '../../../services/projectClient';
import { toast } from '../../../hooks/useToast';

/** 邀请码默认 72 小时有效、最多 10 次（本单固定策略，改策略只动这两个常量） */
export const INVITE_EXPIRES_IN_HOURS = 72;
export const INVITE_MAX_USES = 10;

export interface ProjectSpaceInviteState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  invite: ProjectInvite | null;
  error: string | null;
}

const IDLE: ProjectSpaceInviteState = { status: 'idle', invite: null, error: null };

export function useProjectSpaceInvite() {
  const [state, setState] = useState<ProjectSpaceInviteState>(IDLE);

  const open = useCallback((projectId: string) => {
    setState({ status: 'loading', invite: null, error: null });
    createInvite(projectId, { expiresInHours: INVITE_EXPIRES_IN_HOURS, maxUses: INVITE_MAX_USES })
      .then((invite) => setState({ status: 'ready', invite, error: null }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setState({ status: 'error', invite: null, error: message });
        toast.error(message);
      });
  }, []);

  const close = useCallback(() => setState(IDLE), []);

  return { state, isOpen: state.status !== 'idle', open, close };
}
