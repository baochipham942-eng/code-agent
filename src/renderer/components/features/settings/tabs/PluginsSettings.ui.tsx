import React from 'react';

export const SummaryTile: React.FC<{
  label: string;
  value: number | string;
  tone?: 'default' | 'success' | 'warning';
}> = ({ label, value, tone = 'default' }) => {
  const valueClass = tone === 'success'
    ? 'text-badge-success'
    : tone === 'warning'
      ? 'text-badge-warning'
      : 'text-zinc-100';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className={`text-lg font-semibold ${valueClass}`}>{value}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{label}</div>
    </div>
  );
};

export const Pill: React.FC<{
  children: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}> = ({ children, tone = 'default' }) => {
  const toneClass = tone === 'success'
    ? 'border-badge-success/30 bg-emerald-500/10 text-badge-success'
    : tone === 'warning'
      ? 'border-badge-warning/30 bg-amber-500/10 text-badge-warning'
      : tone === 'danger'
        ? 'border-red-500/30 bg-red-500/10 text-badge-danger'
        : 'border-zinc-700 bg-zinc-800 text-zinc-300';

  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] ${toneClass}`}>
      {children}
    </span>
  );
};
