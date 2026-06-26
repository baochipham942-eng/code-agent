// 侧边栏会话筛选的选项/标签常量（从 Sidebar 抽出，纯数据，无逻辑改动）。
// 状态筛选 + Trajectory（tier/failure/review）筛选，供 Sidebar 与 SidebarStatusFilterDropdown 共用。
import type { SessionStatusFilter, TrajectoryReviewFilter } from '../../../stores/sessionUIStore';
import type {
  AgentTrajectoryGateFailure,
  AgentTrajectoryQualityTier,
} from '@shared/contract/agentTrajectory';

export const SESSION_STATUS_FILTER_OPTIONS: Array<{
  id: SessionStatusFilter;
  label: string;
  adminOnly?: boolean;
}> = [
  { id: 'all', label: '全部' },
  { id: 'unfinished', label: '未完成' },
  { id: 'approval', label: '待确认' },
  { id: 'running', label: '执行中' },
  { id: 'attention', label: '需关注' },
  { id: 'artifact', label: '交付线索' },
  { id: 'review', label: '待审', adminOnly: true },
];

export const SESSION_STATUS_FILTER_LABELS: Record<SessionStatusFilter, string> = {
  all: '全部',
  unfinished: '未完成',
  approval: '待确认',
  running: '执行中',
  attention: '需关注',
  artifact: '交付线索',
  review: '待审',
  background: '后台执行中',
};

export const TRAJECTORY_TIER_FILTER_OPTIONS: Array<{
  id: AgentTrajectoryQualityTier;
  label: string;
}> = [
  { id: 'G2', label: 'G2 Core' },
  { id: 'G1', label: 'G1 Diagnostic' },
  { id: 'G0', label: 'G0 Diagnostic' },
];

export const TRAJECTORY_FAILURE_FILTER_OPTIONS: Array<{
  id: AgentTrajectoryGateFailure;
  label: string;
}> = [
  { id: 'missing_tool_result', label: '缺工具结果' },
  { id: 'missing_tool_schemas', label: '缺工具定义' },
  { id: 'missing_assistant_final_answer', label: '缺最终回答' },
  { id: 'pending_tool_result', label: '工具待闭环' },
  { id: 'ordinary_chat_no_tool', label: '普通聊天' },
  { id: 'transcript_fallback_replay', label: '历史 fallback' },
];

export const TRAJECTORY_REVIEW_FILTER_OPTIONS: Array<{
  id: TrajectoryReviewFilter;
  label: string;
}> = [
  { id: 'pending', label: '待复核' },
  { id: 'reviewed', label: '已复核' },
];

export const TRAJECTORY_REVIEW_FILTER_LABELS: Record<TrajectoryReviewFilter, string> = {
  all: '全部复核状态',
  pending: '待复核',
  reviewed: '已复核',
};
