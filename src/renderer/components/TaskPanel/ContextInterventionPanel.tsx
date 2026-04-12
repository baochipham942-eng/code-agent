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

const selectionLabels: Record<ContextSelectionMode, { label: string; tone: string }> = {
  default: { label: '默认', tone: 'border-white/20 bg-white/5 text-zinc-100' },
  pinned: { label: '已钉住', tone: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200' },
  excluded: { label: '已排除', tone: 'border-amber-500/30 bg-amber-500/5 text-amber-200' },
  retained: { label: '保留', tone: 'border-sky-500/30 bg-sky-500/5 text-sky-200' },
};

const actionButtons: Array<{ action: ContextInterventionAction; label: string; icon: React.ReactNode }> = [
  { action: 'pin', label: '钉住', icon: <Pin className="w-3 h-3" /> },
  { action: 'exclude', label: '排除', icon: <Slash className="w-3 h-3" /> },
  { action: 'retain', label: '保留', icon: <Sparkles className="w-3 h-3" /> },
];

const sourceIcons: Record<ContextSelectionMode, React.ReactNode> = {
  default: <FileText className="w-4 h-4 text-zinc-400" />,
  pinned: <ShieldAlert className="w-4 h-4 text-emerald-400" />,
  excluded: <ShieldAlert className="w-4 h-4 text-amber-400" />,
  retained: <ShieldAlert className="w-4 h-4 text-sky-400" />,
};

const getSourceDetail = (item: ContextItemView) => {
  if (item.provenance.toolNames.length > 0) {
    return `工具：${item.provenance.toolNames.join(', ')}`;
  }
  if (item.provenance.attachmentNames.length > 0) {
    return `附件：${item.provenance.attachmentNames.join(', ')}`;
  }
  return `来源：${item.provenance.sourceType}`;
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
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-white/[0.04] bg-zinc-900/70 p-3">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-amber-400" />
        <div className="text-sm font-medium text-zinc-100">上下文干预</div>
        <span className="text-[10px] text-zinc-500">pin / exclude / retain</span>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((item) => {
          const selection = item.selection ?? 'default';
          const status = selectionLabels[selection];
          const busy = submittingId !== null && submittingId !== item.id;
          const reason = item.provenance.reasons.length > 0
            ? item.provenance.reasons.join('；')
            : '系统自动判断';

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
              <div className="mt-1 text-[11px] text-zinc-500">{getSourceDetail(item)}</div>
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
                          ? 'border-primary-500 bg-primary-500/20 text-primary-200'
                          : 'border-white/10 bg-white/5 text-zinc-300 hover:border-primary-400 hover:text-zinc-100'
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
