import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export type PluginCardStatusTone = 'active' | 'inactive' | 'warning';

interface PluginCardProps {
  testId: string;
  icon: React.ReactNode;
  name: string;
  status: string;
  statusTone: PluginCardStatusTone;
  description: string;
  permissions: readonly string[];
  action: React.ReactNode;
  meta?: React.ReactNode;
  details?: React.ReactNode;
  detailsLabel?: string;
  notice?: React.ReactNode;
}

const statusClass: Record<PluginCardStatusTone, string> = {
  active: 'border-badge-success/30 bg-emerald-500/10 text-badge-success',
  inactive: 'border-zinc-700 bg-zinc-800 text-zinc-400',
  warning: 'border-badge-warning/30 bg-amber-500/10 text-badge-warning',
};

export const PluginCard: React.FC<PluginCardProps> = ({
  testId,
  icon,
  name,
  status,
  statusTone,
  description,
  permissions,
  action,
  meta,
  details,
  detailsLabel,
  notice,
}) => {
  const [expanded, setExpanded] = useState(false);
  const detailsId = `${testId}-details`;

  return (
    <section
      data-testid={testId}
      data-plugin-card="unified"
      className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-badge-accent">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-100">{name}</h3>
              <span className={`rounded-md border px-2 py-0.5 text-[11px] ${statusClass[statusTone]}`}>
                {status}
              </span>
              {meta}
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{description}</p>
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid={`${testId}-permissions`}>
              {permissions.map((permission) => (
                <span
                  key={permission}
                  className="inline-flex items-center rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300"
                >
                  {permission}
                </span>
              ))}
            </div>
            {details && (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={detailsId}
                className="mt-2 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
                onClick={() => setExpanded((current) => !current)}
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                {detailsLabel}
              </button>
            )}
          </div>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      {notice}
      {details && expanded && (
        <div id={detailsId} className="mt-3 border-t border-zinc-800 pt-3">
          {details}
        </div>
      )}
    </section>
  );
};
