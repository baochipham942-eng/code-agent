import React from 'react';
import type { SessionWithMeta } from '../../../stores/sessionStore';

export function getReusableWorkbenchDirectory(session: SessionWithMeta): string | null {
  const candidates = [
    session.workbenchProvenance?.workingDirectory,
    session.workingDirectory,
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

export function canReuseSessionWorkbench(session: SessionWithMeta): boolean {
  const hasWorkspace = Boolean(getReusableWorkbenchDirectory(session));
  const hasRouting =
    (session.workbenchProvenance?.routingMode === 'direct' &&
      (session.workbenchProvenance?.targetAgentIds?.length ?? 0) > 0) ||
    Boolean(
      (session.workbenchProvenance?.routingMode &&
        session.workbenchProvenance.routingMode !== 'direct') ||
      (session.workbenchSnapshot?.routingMode && session.workbenchSnapshot.routingMode !== 'direct'),
    );
  const hasBrowserSession = Boolean(session.workbenchProvenance?.executionIntent?.browserSessionMode);
  const hasCapabilities = Boolean(
    session.workbenchProvenance?.selectedSkillIds?.length ||
      session.workbenchProvenance?.selectedConnectorIds?.length ||
      session.workbenchProvenance?.selectedMcpServerIds?.length ||
      session.workbenchSnapshot?.skillIds?.length ||
      session.workbenchSnapshot?.connectorIds?.length ||
      session.workbenchSnapshot?.mcpServerIds?.length,
  );

  return hasWorkspace || hasRouting || hasBrowserSession || hasCapabilities;
}

export function formatPresetMenuLabel(name: string): string {
  return name.length > 28 ? `${name.slice(0, 25)}...` : name;
}

interface AccountMenuItemProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  badge?: string;
}

export const AccountMenuLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
    {children}
  </div>
);

export const AccountMenuItem: React.FC<AccountMenuItemProps> = ({ icon, label, onClick, badge }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
  >
    {icon}
    <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    {badge ? (
      <span className="shrink-0 rounded border border-zinc-700 bg-zinc-800/70 px-1.5 py-0.5 text-[10px] text-zinc-500">
        {badge}
      </span>
    ) : null}
  </button>
);
