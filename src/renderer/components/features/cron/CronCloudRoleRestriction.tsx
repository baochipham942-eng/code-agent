import React from 'react';
import type { CronJobDraft } from './types';

export const CLOUD_ROLE_BOUND_ERROR = 'Role-bound agent jobs cannot run on the cloud scheduler';

export function isCloudRoleBoundAgentDraft(
  draft: Pick<CronJobDraft, 'runsOn' | 'actionType' | 'agentRoleId'>,
): boolean {
  return draft.runsOn === 'cloud'
    && draft.actionType === 'agent'
    && Boolean(draft.agentRoleId?.trim());
}

export const CronCloudRoleRestriction: React.FC<{
  draft: CronJobDraft;
  message: string;
}> = ({ draft, message }) => {
  if (!isCloudRoleBoundAgentDraft(draft)) return null;
  return (
    <p role="alert" data-testid="cron-cloud-role-restriction" className="text-sm text-badge-danger">
      {message}
    </p>
  );
};
