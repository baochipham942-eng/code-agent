import React from 'react';
import { Clock3, GitBranch, HeartPulse } from 'lucide-react';
import type { SessionType } from '@shared/contract/session';

export type SidebarSessionTypeFilter = 'all' | SessionType;

const SESSION_TYPE_FILTERS: Array<{ value: SidebarSessionTypeFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'chat', label: 'Chat' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'heartbeat', label: 'Heartbeat' },
  { value: 'subagent', label: 'Subagent' },
];

export function getSessionTypeLabel(type: SessionType | undefined): string | null {
  switch (type) {
    case 'schedule':
      return 'Schedule';
    case 'heartbeat':
      return 'Heartbeat';
    case 'subagent':
      return 'Subagent';
    default:
      return null;
  }
}

interface SessionTypeFilterBarProps {
  value: SidebarSessionTypeFilter;
  onChange: (value: SidebarSessionTypeFilter) => void;
}

export const SessionTypeFilterBar: React.FC<SessionTypeFilterBarProps> = ({ value, onChange }) => (
  <div className="px-2 pb-1 flex-shrink-0">
    <div className="flex items-center gap-1 overflow-x-auto">
      {SESSION_TYPE_FILTERS.map((filter) => (
        <button
          key={filter.value}
          type="button"
          onClick={() => onChange(filter.value)}
          className={`shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors ${
            value === filter.value
              ? 'border-zinc-600 bg-zinc-700/60 text-zinc-100'
              : 'border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
          }`}
        >
          {filter.value === 'heartbeat' && <HeartPulse className="mr-1 inline h-3 w-3 align-[-2px]" />}
          {filter.value === 'schedule' && <Clock3 className="mr-1 inline h-3 w-3 align-[-2px]" />}
          {filter.value === 'subagent' && <GitBranch className="mr-1 inline h-3 w-3 align-[-2px]" />}
          {filter.label}
        </button>
      ))}
    </div>
  </div>
);
