// ============================================================================
// CronCenterPanel —— 自动化中心整页外壳。
// 页首三格状态条（运行中 / 待过目 / 成功率）是全页状态锚点：数据复用
// cronStore.stats（运行中=jobsByStatus.running、成功率=successRate）+
// 收件箱回传的待过目数（与侧栏角标同一琥珀色视觉语言）。
// 布局自上而下：状态条 → 待过目收件箱（独立卡片区）→ 推荐模板 → 任务列表+详情。
// 布局契约（2026-07-27 UX 收尾 1.4）：页级横向 padding 统一 px-6（PageContent 契约），
// 状态条卡片走统一卡片语言（rounded-lg border-zinc-800 bg-zinc-900/70）；
// 底部列表+详情双栏为全 bleed 工作台区，padding 由页内面板自管。
// 滚动契约（2026-07-26 打磨批 D D0）：header 以下整体是页级滚动区（overflow-y-auto）——
// 顶区（状态条/收件箱/推荐模板）全是 shrink-0，矮窗口下会吃光高度；工作台 grid 用
// flex-[1_0_420px]：高屏 grow 占满剩余空间，矮屏不低于 420px、整页可滚到达。
// （此前顶区 shrink-0 + grid overflow-hidden 且无页级滚动，矮窗口整页滚不动。）
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { useI18n } from '../../../hooks/useI18n';
import { CronJobList } from './CronJobList';
import { AutomationReviewInbox } from './AutomationReviewInbox';
import { CronFeaturedTemplates } from './CronFeaturedTemplates';
import { CronJobDetail } from './CronJobDetail';
import { CronJobEditor } from './CronJobEditor';
import { WebModeBanner } from '../settings/WebModeBanner';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';

interface CronCenterPanelProps {
  onClose: () => void;
}

const StatusTile: React.FC<{ label: string; value: string; attention?: boolean; testId: string }> = ({
  label,
  value,
  attention = false,
  testId,
}) => (
  <div
    className={`rounded-lg border px-4 py-3 ${
      attention ? 'border-amber-500/30 bg-amber-500/10' : 'border-zinc-800 bg-zinc-900/70'
    }`}
    data-testid={testId}
  >
    <div className={`text-2xl font-semibold tabular-nums ${attention ? 'text-amber-300' : 'text-zinc-100'}`}>
      {value}
    </div>
    <div className="mt-0.5 text-xs text-zinc-500">{label}</div>
  </div>
);

export const CronCenterPanel: React.FC<CronCenterPanelProps> = ({ onClose }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const {
    jobs,
    stats,
    selectedJobId,
    isEditorOpen,
    editingJobId,
    isLoading,
    error,
    refresh,
    closeEditor,
  } = useCronStore();
  // 待过目数由收件箱回传（同一条 listPendingReview 通道，语义与服务侧 countPendingReview 一致），
  // 收件箱里「已过目」后状态条同步归零，不用再发一次 IPC。
  const [pendingReviewCount, setPendingReviewCount] = useState(0);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isEditorOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditorOpen, onClose]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) || null,
    [jobs, selectedJobId]
  );

  const editingJob = useMemo(
    () => jobs.find((job) => job.id === editingJobId) || null,
    [jobs, editingJobId]
  );

  const runningCount = stats?.jobsByStatus?.running ?? 0;

  return (
    <FullScreenPage testId="cron-center-panel">
      <FullScreenPageHeader
        icon={<Clock3 className="h-4 w-4 text-amber-300" />}
        title={cc.title}
        description={cc.subtitle}
        onClose={onClose}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="cron-center-scroll">
        <div className="grid shrink-0 grid-cols-3 gap-3 px-6 pt-4" data-testid="cron-status-bar">
          <StatusTile
            label={cc.statRunning}
            value={stats ? String(runningCount) : '—'}
            testId="cron-status-running"
          />
          <StatusTile
            label={cc.statPendingReview}
            value={String(pendingReviewCount)}
            attention={pendingReviewCount > 0}
            testId="cron-status-pending"
          />
          <StatusTile
            label={cc.statRate}
            value={stats ? `${stats.successRate.toFixed(0)}%` : '—'}
            testId="cron-status-rate"
          />
        </div>

        <WebModeBanner />

        {error && (
          <div className="border-b border-red-500/20 bg-red-500/10 px-6 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <AutomationReviewInbox onPendingCountChange={setPendingReviewCount} />
        <CronFeaturedTemplates />

        <div className="grid flex-[1_0_420px] grid-cols-[360px_1fr] overflow-hidden">
          <CronJobList />
          <div className="min-w-0">
            {isLoading && jobs.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                {cc.loading}
              </div>
            ) : (
              <CronJobDetail job={selectedJob} />
            )}
          </div>
        </div>
      </div>

      <CronJobEditor
        isOpen={isEditorOpen}
        job={editingJob}
        onClose={closeEditor}
      />
    </FullScreenPage>
  );
};

export default CronCenterPanel;
