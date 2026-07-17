// 侧边栏会话筛选的选项/标签构造器（从 Sidebar 抽出，纯数据）。文案走 i18n（t.sidebarFilters.*）。
// 状态筛选 + Trajectory（tier/failure/review）筛选，供 Sidebar 与 SidebarStatusFilterDropdown 共用。
import type { SessionStatusFilter, TrajectoryReviewFilter } from '../../../stores/sessionUIStore';
import type {
  AgentTrajectoryGateFailure,
  AgentTrajectoryQualityTier,
} from '@shared/contract/agentTrajectory';
import type { Translations } from '../../../i18n';

export function buildSessionStatusFilterOptions(t: Translations): Array<{
  id: SessionStatusFilter;
  label: string;
  adminOnly?: boolean;
}> {
  const f = t.sidebarFilters;
  return [
    { id: 'all', label: f.all },
    { id: 'unfinished', label: f.unfinished },
    { id: 'approval', label: f.approval },
    { id: 'running', label: f.running },
    { id: 'attention', label: f.attention },
    { id: 'artifact', label: f.artifact },
    { id: 'review', label: f.review, adminOnly: true },
  ];
}

export function buildSessionStatusFilterLabels(t: Translations): Record<SessionStatusFilter, string> {
  const f = t.sidebarFilters;
  return {
    all: f.all,
    unfinished: f.unfinished,
    approval: f.approval,
    running: f.running,
    attention: f.attention,
    artifact: f.artifact,
    review: f.review,
    background: f.background,
  };
}

export const TRAJECTORY_TIER_FILTER_OPTIONS: Array<{
  id: AgentTrajectoryQualityTier;
  label: string;
}> = [
  { id: 'G2', label: 'G2 Core' },
  { id: 'G1', label: 'G1 Diagnostic' },
  { id: 'G0', label: 'G0 Diagnostic' },
];

export function buildTrajectoryFailureFilterOptions(t: Translations): Array<{
  id: AgentTrajectoryGateFailure;
  label: string;
}> {
  const f = t.sidebarFilters;
  return [
    { id: 'missing_tool_result', label: f.failureMissingToolResult },
    { id: 'missing_tool_schemas', label: f.failureMissingToolSchemas },
    { id: 'missing_assistant_final_answer', label: f.failureMissingFinalAnswer },
    { id: 'pending_tool_result', label: f.failurePendingToolResult },
    { id: 'ordinary_chat_no_tool', label: f.failureOrdinaryChat },
    { id: 'transcript_fallback_replay', label: f.failureTranscriptFallback },
  ];
}

export function buildTrajectoryReviewFilterOptions(t: Translations): Array<{
  id: TrajectoryReviewFilter;
  label: string;
}> {
  const f = t.sidebarFilters;
  return [
    { id: 'pending', label: f.reviewPending },
    { id: 'reviewed', label: f.reviewReviewed },
  ];
}

export function buildTrajectoryReviewFilterLabels(t: Translations): Record<TrajectoryReviewFilter, string> {
  const f = t.sidebarFilters;
  return {
    all: f.reviewAll,
    pending: f.reviewPending,
    reviewed: f.reviewReviewed,
  };
}
