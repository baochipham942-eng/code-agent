import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { startEditRoleChat } from '../../../../utils/startEditRoleChat';
import { RoleDeleteControl } from '../../expert/RoleDeleteControl';

export interface RoleCreatedDirectSummary {
  sessionId: string;
  roleId: string;
  displayName: string;
  canDo: string;
  willNotDo: string;
}

export const RoleCreatedDirectCard: React.FC<{ role: RoleCreatedDirectSummary }> = ({ role }) => {
  const { t } = useI18n();
  const text = t.roleDraft;
  const [deleted, setDeleted] = useState(false);

  return (
    <section
      data-testid="role-created-direct-card"
      data-deleted={deleted ? 'true' : 'false'}
      className="mb-2 rounded-xl border border-border-strong bg-void px-4 py-3 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-badge-success">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{text.createdLabel}</span>
          </div>
          <h3 className="truncate text-sm font-semibold text-text-primary">
            {role.displayName}
          </h3>
        </div>
        {!deleted && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void startEditRoleChat(role.roleId)}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              {text.editCreated}
            </button>
            <RoleDeleteControl
              roleId={role.roleId}
              displayName={role.displayName}
              onDeleted={() => setDeleted(true)}
              onRestored={() => setDeleted(false)}
              openDetailOnRestore={false}
            />
          </div>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-5">
        <dt className="text-text-tertiary">{text.canDoLabel}</dt>
        <dd className="text-text-primary">{role.canDo}</dd>
        <dt className="text-text-tertiary">{text.willNotDoLabel}</dt>
        <dd className="text-text-primary">{role.willNotDo}</dd>
      </dl>
    </section>
  );
};
