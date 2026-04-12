// ============================================================================
// Context Provenance Panel - shows context item reasons and modifications
// ============================================================================

import React from 'react';
import { Activity, MessageSquare, Zap, Link } from 'lucide-react';
import type {
  ContextProvenanceAction,
  ContextProvenanceCategory,
  ContextProvenanceListEntry,
} from '@shared/contract/contextView';

const actionLabels: Record<ContextProvenanceAction, string> = {
  added: '加入',
  retrieved: '检索',
  compressed: '压缩',
  pinned: '钉住',
  excluded: '排除',
  retained: '保留',
};

const categoryLabels: Record<ContextProvenanceCategory, string> = {
  recent_turn: 'Recent Turn',
  tool_result: 'Tool Result',
  attachment: 'Attachment',
  dependency_carry_over: 'Dependency Carry-over',
  manual_pin_retain: 'Manual Pin/Retain',
  compression_survivor: 'Compression Survivor',
  excluded: 'Excluded',
  system_anchor: 'System Anchor',
  unknown: 'Unknown',
};

const sourceIcons: Record<ContextProvenanceListEntry['sourceType'], React.ReactNode> = {
  message: <MessageSquare className="w-4 h-4 text-primary-400" />,
  tool: <Link className="w-4 h-4 text-amber-400" />,
  attachment: <Zap className="w-4 h-4 text-emerald-300" />,
  memory: <Activity className="w-4 h-4 text-violet-300" />,
  file: <Activity className="w-4 h-4 text-cyan-300" />,
};

interface Props {
  entries: ContextProvenanceListEntry[];
}

function inferCategory(entry: ContextProvenanceListEntry): ContextProvenanceCategory {
  if (entry.category) return entry.category;
  if (entry.action === 'excluded') return 'excluded';
  if (entry.action === 'pinned' || entry.action === 'retained') return 'manual_pin_retain';
  if (entry.action === 'compressed') return 'compression_survivor';
  if (entry.sourceType === 'tool') return 'tool_result';
  if (entry.sourceType === 'attachment') return 'attachment';
  return 'recent_turn';
}

function actionTone(action: ContextProvenanceAction): string {
  if (action === 'excluded') return 'text-amber-300 bg-amber-500/10 border-amber-500/25';
  if (action === 'pinned' || action === 'retained') return 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25';
  if (action === 'compressed') return 'text-cyan-300 bg-cyan-500/10 border-cyan-500/25';
  return 'text-zinc-300 bg-zinc-800/80 border-white/[0.06]';
}

export const ContextProvenancePanel: React.FC<Props> = ({ entries }) => {
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-white/[0.04] bg-zinc-900/70 p-3">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-primary-400" />
        <div className="text-sm font-medium text-zinc-100">上下文来源</div>
        <span className="text-[10px] text-zinc-500">Provenance</span>
      </div>
      <div className="mt-3 space-y-2 text-xs text-zinc-300">
        {entries.map((entry) => (
          <div key={entry.id} className="rounded-lg border border-white/[0.04] bg-white/5 px-3 py-2">
            <div className="flex items-center gap-2">
              {sourceIcons[entry.sourceType]}
              <div>
                <div className="text-sm text-zinc-100">{entry.label || entry.source}</div>
                <div className="text-[11px] text-zinc-500">{entry.reason}</div>
              </div>
              <div className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400">
                <span>{entry.timestamp > 0 ? new Date(entry.timestamp).toLocaleTimeString() : '—'}</span>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${actionTone(entry.action)}`}>
                {actionLabels[entry.action]}
              </span>
              <span className="rounded-full border border-white/[0.06] bg-zinc-800/80 px-2 py-0.5 text-[10px] text-zinc-300">
                {categoryLabels[inferCategory(entry)]}
              </span>
              <span className="rounded-full border border-white/[0.06] bg-zinc-800/80 px-2 py-0.5 text-[10px] text-zinc-400">
                {entry.sourceType}
              </span>
              {entry.agentId && (
                <span className="rounded-full border border-white/[0.06] bg-zinc-800/80 px-2 py-0.5 text-[10px] text-cyan-300">
                  {entry.agentId}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
