// ============================================================================
// Context Intervention Panel - controls for pin/exclude/retain actions
// ============================================================================

import React from 'react';
import {
  FileText,
  Pin,
  Slash,
  Sparkles,
  ShieldAlert,
} from 'lucide-react';
import type {
  ContextItemView,
  ContextInterventionAction,
  ContextSelectionMode,
} from '@shared/contract/contextView';
import { useI18n } from '../../hooks/useI18n';
import type { Translations } from '../../i18n';

const selectionTone: Record<ContextSelectionMode, string> = {
  default: 'border-white/20 bg-white/5 text-zinc-100',
  pinned: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200',
  excluded: 'border-amber-500/30 bg-amber-500/5 text-amber-200',
  retained: 'border-sky-500/30 bg-sky-500/5 text-sky-200',
};

function getSelectionLabels(t: Translations): Record<ContextSelectionMode, { label: string; tone: string }> {
  const ci = t.taskStatusPanels.contextIntervention;
  return {
    default: { label: ci.selectionDefault, tone: selectionTone.default },
    pinned: { label: ci.selectionPinned, tone: selectionTone.pinned },
    excluded: { label: ci.selectionExcluded, tone: selectionTone.excluded },
    retained: { label: ci.selectionRetained, tone: selectionTone.retained },
  };
}

function getActionButtons(t: Translations): Array<{ action: ContextInterventionAction; label: string; icon: React.ReactNode }> {
  const ci = t.taskStatusPanels.contextIntervention;
  return [
    { action: 'pin', label: ci.actionPin, icon: <Pin className="w-3 h-3" /> },
    { action: 'exclude', label: ci.actionExclude, icon: <Slash className="w-3 h-3" /> },
    { action: 'retain', label: ci.actionRetain, icon: <Sparkles className="w-3 h-3" /> },
  ];
}

const sourceIcons: Record<ContextSelectionMode, React.ReactNode> = {
  default: <FileText className="w-4 h-4 text-zinc-400" />,
  pinned: <ShieldAlert className="w-4 h-4 text-emerald-400" />,
  excluded: <ShieldAlert className="w-4 h-4 text-amber-400" />,
  retained: <ShieldAlert className="w-4 h-4 text-sky-400" />,
};

const getSourceDetail = (item: ContextItemView, t: Translations) => {
  const ci = t.taskStatusPanels.contextIntervention;
  if (item.provenance.toolNames.length > 0) {
    return ci.sourceTool.replace('{names}', item.provenance.toolNames.join(', '));
  }
  if (item.provenance.attachmentNames.length > 0) {
    return ci.sourceAttachment.replace('{names}', item.provenance.attachmentNames.join(', '));
  }
  return ci.sourceType.replace('{type}', item.provenance.sourceType);
};

interface Props {
  items: ContextItemView[];
  onAction: (itemId: string, action: ContextInterventionAction, enabled: boolean) => void;
  submittingId: string | null;
}

export const ContextInterventionPanel: React.FC<Props> = ({
  items,
  onAction,
  submittingId,
}) => {
  const { t } = useI18n();
  const ci = t.taskStatusPanels.contextIntervention;
  const selectionLabels = getSelectionLabels(t);
  const actionButtons = getActionButtons(t);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-white/[0.04] bg-zinc-900/70 p-3">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-amber-400" />
        <div className="text-sm font-medium text-zinc-100">{ci.title}</div>
        <span className="text-[10px] text-zinc-500">pin / exclude / retain</span>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((item) => {
          const selection = item.selection ?? 'default';
          const status = selectionLabels[selection];
          const busy = submittingId !== null && submittingId !== item.id;
          const reason = item.provenance.reasons.length > 0
            ? item.provenance.reasons.join('；')
            : ci.reasonAuto;

          return (
            <div
              key={item.id}
              className="rounded-lg border border-white/[0.04] bg-white/5 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                {sourceIcons[selection]}
                <div>
                  <div className="text-sm text-zinc-100">{item.role}</div>
                  <div className="text-[11px] text-zinc-500 line-clamp-2">{item.contentPreview}</div>
                </div>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${status.tone}`}>
                  {status.label}
                </span>
              </div>
              <div className="mt-1 text-xs text-zinc-400">{reason}</div>
              <div className="mt-1 text-[11px] text-zinc-500">{getSourceDetail(item, t)}</div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-300">
                {actionButtons.map((action) => {
                  const isActive =
                    (selection === 'pinned' && action.action === 'pin')
                    || (selection === 'excluded' && action.action === 'exclude')
                    || (selection === 'retained' && action.action === 'retain');
                  const nextEnabled = !isActive;

                  return (
                    <button
                      key={`${item.id}-${action.action}`}
                      disabled={busy}
                      onClick={() => onAction(item.id, action.action, nextEnabled)}
                      className={`flex items-center gap-1 rounded border px-2 py-1 transition ${
                        isActive
                          ? 'border-zinc-500 bg-zinc-800/70 text-zinc-100'
                          : 'border-white/10 bg-white/5 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
                      }`}
                    >
                      {action.icon}
                      <span>{action.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
