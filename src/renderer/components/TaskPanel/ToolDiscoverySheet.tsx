import React from 'react';
import { X } from 'lucide-react';
import type { ToolCapabilityView } from '../../types/runWorkbench';
import { buildToolDiscoveryGroups } from '../../utils/toolDiscoveryPresentation';
import { WorkbenchPill } from '../workbench/WorkbenchPrimitives';

interface ToolDiscoverySheetProps {
  isOpen: boolean;
  tools: ToolCapabilityView[];
  onClose: () => void;
}

function sourceTone(source: ToolCapabilityView['source']): 'skill' | 'connector' | 'mcp' | 'neutral' | 'info' {
  if (source === 'skill') return 'skill';
  if (source === 'connector') return 'connector';
  if (source === 'mcp') return 'mcp';
  if (source === 'computer' || source === 'memory') return 'info';
  return 'neutral';
}

function groupTone(key: string): string {
  switch (key) {
    case 'callable':
      return 'text-emerald-300';
    case 'needsAuthorization':
      return 'text-amber-300';
    case 'blocked':
      return 'text-red-300';
    default:
      return 'text-sky-300';
  }
}

export const ToolDiscoverySheet: React.FC<ToolDiscoverySheetProps> = ({
  isOpen,
  tools,
  onClose,
}) => {
  if (!isOpen) return null;

  const groups = buildToolDiscoveryGroups(tools);

  return (
    <div className="fixed inset-y-4 right-4 z-50 w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-white/[0.08] bg-zinc-950/95 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-100">Tool Discovery</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            本轮工具能力变化 · {tools.length} 项
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200"
          aria-label="关闭工具发现"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="max-h-[calc(100vh-7rem)] overflow-y-auto px-3 py-3">
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.key} className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className={`text-[11px] font-medium ${groupTone(group.key)}`}>{group.label}</span>
                <span className="text-[10px] text-zinc-600">{group.tools.length}</span>
              </div>

              {group.tools.length > 0 ? (
                <div className="space-y-1.5">
                  {group.tools.map((tool) => (
                    <div key={`${group.key}-${tool.id}`} className="rounded-md bg-black/15 px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <WorkbenchPill tone={sourceTone(tool.source)}>{tool.source}</WorkbenchPill>
                        <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{tool.label}</span>
                        <span className="text-[10px] text-zinc-600">{tool.permissionLevel || 'unknown'}</span>
                      </div>
                      {tool.blockedReason && (
                        <div className="mt-1 truncate text-[11px] text-amber-300">{tool.blockedReason}</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-zinc-600">无</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
