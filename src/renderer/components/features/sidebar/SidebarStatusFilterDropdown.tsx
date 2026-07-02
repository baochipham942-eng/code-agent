// 侧边栏顶部「按状态筛选」下拉（仅管理员可见，从 Sidebar 抽出，纯结构抽取无渲染变化）。
// 受控组件：下拉开合态/ref/外点关闭由父组件持有（保持 Sidebar useState 顺序稳定），筛选值/setter 透传。
import React from 'react';
import { ListFilter, Check } from 'lucide-react';
import type { SessionStatusFilter, TrajectoryReviewFilter } from '../../../stores/sessionUIStore';
import type {
  AgentTrajectoryGateFailure,
  AgentTrajectoryQualityTier,
} from '@shared/contract/agentTrajectory';
import {
  TRAJECTORY_TIER_FILTER_OPTIONS,
  TRAJECTORY_FAILURE_FILTER_OPTIONS,
  TRAJECTORY_REVIEW_FILTER_OPTIONS,
} from './sidebarFilterOptions';

interface SidebarStatusFilterDropdownProps {
  statusFilterOpen: boolean;
  setStatusFilterOpen: React.Dispatch<React.SetStateAction<boolean>>;
  statusFilterRef: React.RefObject<HTMLDivElement | null>;
  visibleStatusFilterOptions: Array<{ id: SessionStatusFilter; label: string; adminOnly?: boolean }>;
  sessionStatusFilter: SessionStatusFilter;
  setSessionStatusFilter: (id: SessionStatusFilter) => void;
  trajectoryTierFilter: AgentTrajectoryQualityTier | 'all';
  setTrajectoryTierFilter: (id: AgentTrajectoryQualityTier | 'all') => void;
  trajectoryFailureFilter: AgentTrajectoryGateFailure | 'all';
  setTrajectoryFailureFilter: (id: AgentTrajectoryGateFailure | 'all') => void;
  trajectoryReviewFilter: TrajectoryReviewFilter;
  setTrajectoryReviewFilter: (id: TrajectoryReviewFilter) => void;
  hasActiveTrajectoryFilter: boolean;
  hasActiveStatusDropdownFilter: boolean;
  activeStatusFilterLabel: string;
}

export const SidebarStatusFilterDropdown: React.FC<SidebarStatusFilterDropdownProps> = ({
  statusFilterOpen,
  setStatusFilterOpen,
  statusFilterRef,
  visibleStatusFilterOptions,
  sessionStatusFilter,
  setSessionStatusFilter,
  trajectoryTierFilter,
  setTrajectoryTierFilter,
  trajectoryFailureFilter,
  setTrajectoryFailureFilter,
  trajectoryReviewFilter,
  setTrajectoryReviewFilter,
  hasActiveTrajectoryFilter,
  hasActiveStatusDropdownFilter,
  activeStatusFilterLabel,
}) => {
  return (
    <div className="relative shrink-0" ref={statusFilterRef}>
      <button
        type="button"
        onClick={() => setStatusFilterOpen((v) => !v)}
        aria-label="按状态筛选会话"
        aria-expanded={statusFilterOpen}
        title={!hasActiveStatusDropdownFilter ? '按状态筛选会话' : `状态筛选：${activeStatusFilterLabel}`}
        className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${hasActiveStatusDropdownFilter ? 'border-zinc-500 bg-zinc-700/70 text-zinc-100' : 'border-transparent text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'}`}
      >
        <ListFilter className="h-4 w-4" />
        {hasActiveStatusDropdownFilter && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-cyan-400" />
        )}
      </button>
      {statusFilterOpen && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[220px] rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-xl">
          <div className="px-3 pb-1 pt-1 text-[10px] uppercase tracking-wider text-zinc-500">按状态筛选</div>
          {visibleStatusFilterOptions.map((option) => {
            const active = sessionStatusFilter === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  setSessionStatusFilter(option.id);
                  if (option.id !== 'review') {
                    setTrajectoryTierFilter('all');
                    setTrajectoryFailureFilter('all');
                    setTrajectoryReviewFilter('all');
                  }
                  setStatusFilterOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-zinc-700 ${active ? 'text-zinc-100' : 'text-zinc-400'}`}
              >
                <Check className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-cyan-400' : 'text-transparent'}`} />
                <span>{option.label}</span>
              </button>
            );
          })}
          <div className="my-1 border-t border-zinc-700/70" />
          <div className="px-3 pb-1 pt-1 text-[10px] uppercase tracking-wider text-zinc-500">
            Review Queue Trajectory
          </div>
          <div className="px-2 py-1">
            <div className="mb-1 flex flex-wrap gap-1">
              {TRAJECTORY_REVIEW_FILTER_OPTIONS.map((option) => {
                const active = trajectoryReviewFilter === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setSessionStatusFilter('review');
                      setTrajectoryReviewFilter(active ? 'all' : option.id);
                    }}
                    className={`rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${active ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-zinc-700 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'}`}
                  >
                    {option.label}
                  </button>
                );
              })}
              {TRAJECTORY_TIER_FILTER_OPTIONS.map((option) => {
                const active = trajectoryTierFilter === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setSessionStatusFilter('review');
                      setTrajectoryTierFilter(active ? 'all' : option.id);
                    }}
                    className={`rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${active ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' : 'border-zinc-700 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'}`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div className="grid gap-0.5">
              {TRAJECTORY_FAILURE_FILTER_OPTIONS.map((option) => {
                const active = trajectoryFailureFilter === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setSessionStatusFilter('review');
                      setTrajectoryFailureFilter(active ? 'all' : option.id);
                    }}
                    className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors ${active ? 'bg-amber-500/10 text-amber-200' : 'text-zinc-400 hover:bg-zinc-700/70 hover:text-zinc-200'}`}
                  >
                    <Check className={`h-3 w-3 shrink-0 ${active ? 'text-amber-300' : 'text-transparent'}`} />
                    <span className="truncate">{option.label}</span>
                  </button>
                );
              })}
            </div>
            {hasActiveTrajectoryFilter && (
              <button
                type="button"
                onClick={() => {
                  setTrajectoryTierFilter('all');
                  setTrajectoryFailureFilter('all');
                  setTrajectoryReviewFilter('all');
                }}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900/40 px-2 py-1 text-left text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
              >
                清除 Trajectory 筛选
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
