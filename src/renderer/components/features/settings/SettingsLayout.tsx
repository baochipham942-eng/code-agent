// ============================================================================
// SettingsLayout - small shared page primitives for settings tabs
// ============================================================================

import React from 'react';
import { ChevronDown } from 'lucide-react';

interface SettingsPageProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

interface SettingsSectionProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

interface SettingsDetailsProps extends SettingsSectionProps {
  defaultOpen?: boolean;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  title,
  description,
  children,
}) => (
  <div className="space-y-6">
    <header>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">{title}</h3>
      <p className="text-xs text-zinc-400">{description}</p>
    </header>
    {children}
  </div>
);

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  actions,
  children,
}) => (
  <section className="space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h4 className="text-sm font-medium text-zinc-200">{title}</h4>
        {description ? (
          <p className="text-xs text-zinc-500 mt-1">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
    {children}
  </section>
);

export const SettingsDetails: React.FC<SettingsDetailsProps> = ({
  title,
  description,
  actions,
  children,
  defaultOpen = false,
}) => (
  <details
    className="group rounded-lg border border-zinc-700/70 bg-zinc-900/50"
    open={defaultOpen}
  >
    <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-3 py-3">
      <div>
        <h4 className="text-sm font-medium text-zinc-200">{title}</h4>
        {description ? (
          <p className="text-xs text-zinc-500 mt-1">{description}</p>
        ) : null}
      </div>
      <div
        className="flex shrink-0 items-center gap-2"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {actions}
        <ChevronDown className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-180" />
      </div>
    </summary>
    <div className="border-t border-zinc-700/60 px-3 py-3">
      {children}
    </div>
  </details>
);
