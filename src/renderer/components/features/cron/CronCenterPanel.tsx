// ============================================================================
// CronCenterPanel —— 自动化中心整页外壳。
// 2026-07-27 批C4（WorkBuddy 式结构改造，产品负责人拍板）：pill 导航「定时任务 | 运行记录」。
//   * 定时任务 tab：状态条 → 推荐模板（独立成块）→ 任务列表+详情工作台
//   * 运行记录 tab：待过目收件箱（本质是运行结果的子集）→ 跨任务执行流（点击看详情）
// 页首三格状态条是全页状态锚点：数据复用 cronStore.stats（运行中=jobsByStatus.running、
// 成功率=successRate）+ 收件箱回传的待过目数（与侧栏角标同一琥珀色视觉语言）。
// 布局契约（2026-07-27 UX 收尾 1.4）：页级横向 padding 统一 px-6（PageContent 契约），
// 状态条卡片走统一卡片语言（rounded-lg border-zinc-800 bg-zinc-900/70）；
// 底部列表+详情双栏为全 bleed 工作台区，padding 由页内面板自管。
// 滚动契约（2026-07-26 打磨批 D D0）：header 以下整体是页级滚动区（overflow-y-auto）——
// 顶区全是 shrink-0，工作台 grid 用 flex-[1_0_420px]：高屏 grow 占满剩余空间，
// 矮屏不低于 420px、整页可滚到达。
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
import { CronExecutionList } from './CronExecutionList';
import { CronExecutionDetail } from './CronExecutionDetail';
import { WebModeBanner } from '../settings/WebModeBanner';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';

interface CronCenterPanelProps {
  onClose: () => void;
}

type CronCenterTab = 'jobs' | 'runs';

const StatusTile: React.FC<{ label: string; value: string; attention?: boolean; testId: string }> = ({
  label,
  value,
  attention = false,
  testId,
}) => (
  <div
    className={`rounded-lg border px-4 py-3 ${
      attention ? 'border-badge-warning/30 bg-amber-500/10' : 'border-zinc-800 bg-zinc-900/70'
    }`}
    data-testid={testId}
  >
    <div className={`text-2xl font-semibold tabular-nums ${attention ? 'text-badge-warning' : 'text-zinc-100'}`}>
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
    recentExecutions,
    loadRecentExecutions,
  } = useCronStore();
  const [activeTab, setActiveTab] = useState<CronCenterTab>('jobs');
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  // 待过目数由收件箱回传（同一条 listPendingReview 通道，语义与服务侧 countPendingReview 一致），
  // 收件箱里「已过目」后状态条同步归零，不用再发一次 IPC。
  const [pendingReviewCount, setPendingReviewCount] = useState(0);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 运行记录 tab 首次进入/切回时拉最新执行流
  useEffect(() => {
    if (activeTab === 'runs') void loadRecentExecutions();
  }, [activeTab, loadRecentExecutions]);

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

  const jobNameById = useMemo(
    () => Object.fromEntries(jobs.map((job) => [job.id, job.name])),
    [jobs]
  );

  const selectedExecution = useMemo(
    () => recentExecutions.find((execution) => execution.id === selectedExecutionId) || null,
    [recentExecutions, selectedExecutionId]
  );

  const runningCount = stats?.jobsByStatus?.running ?? 0;

  const tabs: Array<{ key: CronCenterTab; label: string }> = [
    { key: 'jobs', label: cc.tabJobs },
    { key: 'runs', label: cc.tabRuns },
  ];

  return (
    <FullScreenPage testId="cron-center-panel" variant="inline">
      <FullScreenPageHeader
        icon={<Clock3 className="h-4 w-4 text-badge-warning" />}
        title={cc.title}
        description={cc.subtitle}
        actions={
          <nav className="flex rounded-md border border-zinc-700 p-0.5" role="tablist">
            {tabs.map(({ key, label }) => (
              <button /* ds-allow:button: 自动化页 tab 切换胶囊（role=tab 分段控件），与评测中心同形态，Button primitive 无 tab 语义变体 */
                key={key}
                type="button"
                role="tab"
                aria-selected={activeTab === key}
                data-testid={`cron-center-tab-${key}`}
                onClick={() => setActiveTab(key)}
                className={`relative rounded px-2.5 py-1 text-xs transition-colors ${
                  activeTab === key ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
                {key === 'runs' && pendingReviewCount > 0 && (
                  <span
                    data-testid="cron-center-runs-badge"
                    className="absolute -right-1 -top-1 rounded-full border border-badge-warning/40 bg-amber-500/20 px-1 text-[9px] leading-3 text-badge-warning"
                  >
                    {pendingReviewCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
        }
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
          <div className="border-b border-red-500/20 bg-red-500/10 px-6 py-2 text-sm text-badge-danger">
            {error}
          </div>
        )}

        {/* 收件箱常驻挂载（两个 tab 共用）：待过目数是状态条与 tab 角标的数据源，
            切 tab 用 CSS 隐藏而不是卸载，不丢数、不重复拉取。收件箱按产品语义
            归属「运行记录」——它是运行结果里需要人过目的子集。 */}
        <div className={activeTab === 'runs' ? undefined : 'hidden'}>
          <AutomationReviewInbox onPendingCountChange={setPendingReviewCount} />
        </div>

        {activeTab === 'jobs' ? (
          <>
            {/* 模板区独立成块（拍板）：与任务工作台分离，点一下即建 */}
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
          </>
        ) : (
          <div className="grid flex-[1_0_420px] grid-cols-[minmax(0,3fr)_minmax(280px,2fr)] items-start gap-4 px-6 py-4" data-testid="cron-runs-workbench">
            <CronExecutionList
              executions={recentExecutions}
              selectedExecutionId={selectedExecutionId}
              onSelectExecution={setSelectedExecutionId}
              jobNameById={jobNameById}
            />
            <div className="min-w-0">
              <CronExecutionDetail execution={selectedExecution} />
            </div>
          </div>
        )}
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
