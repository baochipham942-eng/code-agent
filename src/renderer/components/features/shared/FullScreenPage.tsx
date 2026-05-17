import React from 'react';
import { X } from 'lucide-react';

interface FullScreenPageProps {
  children: React.ReactNode;
  className?: string;
  testId?: string;
}

interface FullScreenPageHeaderProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
  closeLabel: string;
}

export const FullScreenPage: React.FC<FullScreenPageProps> = ({
  children,
  className = '',
  testId,
}) => (
  <div
    data-testid={testId}
    className={`fixed inset-0 z-50 flex min-h-0 flex-col bg-zinc-950 text-zinc-100 ${className}`}
  >
    {children}
  </div>
);

export const FullScreenPageHeader: React.FC<FullScreenPageHeaderProps> = ({
  icon,
  title,
  description,
  badge,
  actions,
  onClose,
  closeLabel,
}) => (
  <header
    className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-5"
    style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
  >
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700/70 bg-zinc-900">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-semibold text-zinc-100">{title}</h2>
          {badge}
        </div>
        {description ? <p className="mt-0.5 truncate text-xs text-zinc-500">{description}</p> : null}
      </div>
    </div>

    <div
      className="flex shrink-0 items-center gap-2"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {actions}
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  </header>
);
