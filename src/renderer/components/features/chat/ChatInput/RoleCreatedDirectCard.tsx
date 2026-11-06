import React, { useState } from 'react';
import { Check, MessageSquarePlus } from 'lucide-react';
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
      className="mb-2 rounded-xl border border-zinc-200/80 bg-white/60 px-4 py-3 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/40"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-badge-success">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{text.createdLabel}</span>
          </div>
          <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {role.displayName}
          </h3>
        </div>
        {!deleted && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void startEditRoleChat(role.roleId)}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
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
        <dt className="text-zinc-500 dark:text-zinc-400">{text.canDoLabel}</dt>
        <dd className="text-zinc-700 dark:text-zinc-200">{role.canDo}</dd>
        <dt className="text-zinc-500 dark:text-zinc-400">{text.willNotDoLabel}</dt>
        <dd className="text-zinc-700 dark:text-zinc-200">{role.willNotDo}</dd>
      </dl>
    </section>
  );
};
