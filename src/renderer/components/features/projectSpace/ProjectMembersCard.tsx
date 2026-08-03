// ============================================================================
// ProjectMembersCard —— 右栏第五卡「成员」（仅 cloudProjectId 非空的云协同空间渲染）。
// 只读列表 + 「邀请」入口（走页头同一邀请 Modal，逻辑在 useProjectSpaceInvite，不复制）。
// 视觉节奏复用 ProjectConfigCard（同款 section 边框/标题行），但不硬套其选用交互。
// 加载/空/取数失败三态全覆盖，卡不消失（房规：能力不可用要降级提示不是消失）。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { ProjectMember } from '@shared/contract/project';
import { listMembers } from '../../../services/projectClient';
import { useI18n } from '../../../hooks/useI18n';
import { Badge } from '../../primitives/Badge';
import { GhostButton } from '../../primitives/Button';

export interface ProjectMembersCardProps {
  projectId: string;
  /** 打开空间邀请码 Modal（页头按钮同一实例） */
  onInvite: () => void;
}

type MembersState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; members: ProjectMember[] };

function memberLabel(member: ProjectMember): string {
  return member.displayName?.trim() || member.userId;
}

export const ProjectMembersCard: React.FC<ProjectMembersCardProps> = ({ projectId, onInvite }) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const [state, setState] = useState<MembersState>({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    listMembers(projectId)
      .then((members) => setState({ status: 'ready', members }))
      .catch(() => setState({ status: 'error' }));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3" data-testid="project-space-members-card">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{ps.cardMembers}</h3>
        <GhostButton size="sm" onClick={onInvite} data-testid="project-space-members-invite">
          {ps.invite}
        </GhostButton>
      </div>
      <div className="mt-2 grid gap-1.5" data-testid="project-space-members-body">
        {state.status === 'loading' ? (
          <span className="text-xs text-zinc-600" data-testid="project-space-members-loading">{ps.membersLoading}</span>
        ) : state.status === 'error' ? (
          <span className="text-xs text-badge-danger" data-testid="project-space-members-error">{ps.membersLoadFailed}</span>
        ) : state.members.length === 0 ? (
          <span className="text-xs text-zinc-600" data-testid="project-space-members-empty">{ps.membersEmpty}</span>
        ) : (
          state.members.map((member) => (
            <div key={member.userId} className="flex min-w-0 items-center gap-2" data-testid={`project-space-members-row-${member.userId}`}>
              {member.avatarUrl ? (
                <img src={member.avatarUrl} alt="" className="h-6 w-6 shrink-0 rounded-full" />
              ) : (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-500/20 text-[11px] font-medium text-badge-accent" aria-hidden="true">
                  {memberLabel(member).slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">{memberLabel(member)}</span>
              <Badge
                className={`text-[11px] ${member.role === 'owner'
                  ? 'border-badge-accent/30 bg-violet-500/10 text-badge-accent'
                  : 'border-zinc-700 bg-zinc-800/70 text-zinc-400'}`}
                data-testid={`project-space-members-role-${member.userId}`}
              >
                {member.role === 'owner' ? ps.memberRoleOwner : ps.memberRoleMember}
              </Badge>
            </div>
          ))
        )}
      </div>
    </section>
  );
};
