import React from 'react';
import { Info, Plug, Sparkles } from 'lucide-react';
import type { WorkbenchHistoryItem, WorkbenchReference } from '../../hooks/useWorkbenchCapabilities';
import { getWorkbenchReferenceBadge, getWorkbenchReferenceTitle } from '../../utils/workbenchPresentation';

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export type WorkbenchPillTone = 'neutral' | 'agent' | 'skill' | 'connector' | 'mcp' | 'info';

const DISPLAY_PILL_TONE_CLASSES: Record<WorkbenchPillTone, string> = {
  neutral: 'border-white/[0.08] bg-zinc-900/60 text-zinc-400',
  agent: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300',
  skill: 'border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-200',
  connector: 'border-sky-500/20 bg-sky-500/10 text-sky-200',
  mcp: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200',
  info: 'border-amber-500/20 bg-amber-500/10 text-amber-200',
};

const SELECTED_PILL_TONE_CLASSES: Record<WorkbenchPillTone, string> = {
  neutral: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-200',
  agent: 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300',
  skill: 'border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-200',
  connector: 'border-sky-500/40 bg-sky-500/15 text-sky-200',
  mcp: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
  info: 'border-amber-500/40 bg-amber-500/15 text-amber-200',
};

interface WorkbenchSectionHeaderProps {
  icon: React.ReactNode;
  label: string;
  count?: string | number;
  className?: string;
  labelClassName?: string;
  countClassName?: string;
}

export function WorkbenchSectionHeader({
  icon,
  label,
  count,
  className,
  labelClassName,
  countClassName,
}: WorkbenchSectionHeaderProps) {
  return (
    <div className={joinClasses('flex items-center gap-1.5 px-1', className)}>
      {icon}
      <span className={joinClasses('text-[10px] text-zinc-500 uppercase', labelClassName)}>
        {label}
      </span>
      {count !== undefined && (
        <span className={joinClasses('text-[10px] text-zinc-600', countClassName)}>
          {count}
        </span>
      )}
    </div>
  );
}

export const WorkbenchSectionLabel = WorkbenchSectionHeader;

interface WorkbenchPillProps {
  tone?: WorkbenchPillTone;
  title?: string;
  className?: string;
  children: React.ReactNode;
}

export function WorkbenchPill({
  tone = 'neutral',
  title,
  className,
  children,
}: WorkbenchPillProps) {
  return (
    <span
      title={title}
      className={joinClasses(
        'rounded-full border px-2 py-0.5 text-[10px]',
        DISPLAY_PILL_TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

interface WorkbenchSelectablePillProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  tone?: WorkbenchPillTone;
  selected?: boolean;
  dimmed?: boolean;
  children: React.ReactNode;
}

export function WorkbenchSelectablePill({
  tone = 'neutral',
  selected = false,
  dimmed = false,
  className,
  children,
  ...buttonProps
}: WorkbenchSelectablePillProps) {
  return (
    <button
      type="button"
      {...buttonProps}
      className={joinClasses(
        'rounded-full border px-2 py-1 text-[11px] transition-colors',
        selected
          ? SELECTED_PILL_TONE_CLASSES[tone]
          : 'border-white/[0.08] bg-zinc-900/50 text-zinc-400 hover:border-white/[0.14] hover:text-zinc-200',
        dimmed && 'opacity-60',
        className,
      )}
    >
      {children}
    </button>
  );
}

interface WorkbenchCapabilityDetailButtonProps {
  label: string;
  onClick: () => void;
  className?: string;
}

export function WorkbenchCapabilityDetailButton({
  label,
  onClick,
  className,
}: WorkbenchCapabilityDetailButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`查看 ${label} 详情`}
      title={`查看 ${label} 详情`}
      className={joinClasses(
        'inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/[0.08] bg-zinc-900/60 text-zinc-500 transition-colors hover:border-white/[0.14] hover:text-zinc-200',
        className,
      )}
    >
      <Info className="h-3 w-3" />
    </button>
  );
}

interface WorkbenchLabelStackProps {
  label: string;
  secondary?: string | null;
  title?: string;
  labelClassName?: string;
  secondaryClassName?: string;
}

export function WorkbenchLabelStack({
  label,
  secondary,
  title,
  labelClassName = 'text-sm text-zinc-400 truncate',
  secondaryClassName = 'text-[10px] text-zinc-500 truncate',
}: WorkbenchLabelStackProps) {
  return (
    <div className="min-w-0 flex-1" title={title}>
      <div className={labelClassName}>{label}</div>
      {secondary && (
        <div className={secondaryClassName}>
          {secondary}
        </div>
      )}
    </div>
  );
}

interface WorkbenchHistoryRowProps {
  item: WorkbenchHistoryItem;
  summary?: string | null;
}

export function WorkbenchHistoryRow({ item, summary }: WorkbenchHistoryRowProps) {
  return (
    <div
      className="flex items-center gap-2 py-1 px-2 rounded bg-zinc-800 text-xs"
      title={summary ? `${item.label}: ${summary}` : item.label}
    >
      {summary ? (
        <>
          <span className="text-zinc-600 flex-shrink-0">{item.label}</span>
          <span className="flex-1 text-zinc-400 truncate">{summary}</span>
        </>
      ) : (
        <span className="flex-1 text-zinc-400 truncate">{item.label}</span>
      )}
      <span className="text-zinc-600">{item.count}x</span>
    </div>
  );
}

interface WorkbenchReferenceRowProps {
  reference: WorkbenchReference;
  locale?: 'zh' | 'en';
  onOpenDetails?: (() => void) | null;
}

export function WorkbenchReferenceRow({
  reference,
  locale = 'zh',
  onOpenDetails,
}: WorkbenchReferenceRowProps) {
  const badge = getWorkbenchReferenceBadge(reference, { locale });
  return (
    <div
      className="flex items-center gap-2 py-0.5"
      title={getWorkbenchReferenceTitle(reference, { locale })}
    >
      {reference.kind === 'skill' ? (
        <Sparkles className={`w-3 h-3 flex-shrink-0 ${
          reference.mounted ? 'text-purple-400/70' : 'text-emerald-400/70'
        }`} />
      ) : (
        <Plug className={`w-3 h-3 flex-shrink-0 ${
          reference.kind === 'connector' ? 'text-sky-400/70' : 'text-blue-400/70'
        }`} />
      )}
      <span className="text-xs text-zinc-400 truncate">{reference.label}</span>
      {badge && (
        <span className="text-[10px] text-zinc-600 shrink-0">
          {badge}
        </span>
      )}
      {onOpenDetails && (
        <WorkbenchCapabilityDetailButton
          label={reference.label}
          onClick={onOpenDetails}
          className="ml-auto h-5 w-5"
        />
      )}
    </div>
  );
}
