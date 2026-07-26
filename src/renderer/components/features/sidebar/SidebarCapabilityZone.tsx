// ============================================================================
// SidebarCapabilityZone —— 侧栏能力区（会话列表上方的一等能力入口）。
// 三个槽位：能力中心、资料库与自动化。
// 数据只读复用 cronStore，不新增数据通道。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { Clock3, ChevronRight, BookOpen, Boxes } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { sessionAutomationClient } from '../../../services/sessionAutomationClient';
import { Badge } from '../../primitives/Badge';

/** 下次运行时间：今天只显 HH:mm，其他日期带月日 */
function formatNextRun(ts: number, locale: string): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return `${date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })} ${time}`;
}

export const SidebarCapabilityZone: React.FC = () => {
  const { t, language } = useI18n();
  const cz = t.sidebar.capabilityZone;
  const { showCronCenter, openCapabilityHub, setShowCronCenter, setShowLibraryPanel } = useAppStore();
  const jobs = useCronStore((state) => state.jobs);
  const stats = useCronStore((state) => state.stats);
  const refresh = useCronStore((state) => state.refresh);

  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    // 面板关闭时任务/待审大概率有变化，跟着刷新一次
    if (showCronCenter) return;
    void refresh();
    sessionAutomationClient.countPendingReview()
      .then((count) => setPendingCount(count ?? 0))
      .catch(() => setPendingCount(0));
  }, [showCronCenter, refresh]);

  const runningCount = stats?.jobsByStatus?.running ?? 0;
  const enabledJobs = useMemo(() => jobs.filter((job) => job.enabled), [jobs]);
  const nextJob = useMemo(() => {
    let candidate: { name: string; at: number } | null = null;
    const now = Date.now();
    for (const job of enabledJobs) {
      if (job.nextRunAt == null || job.nextRunAt < now) continue;
      if (!candidate || job.nextRunAt < candidate.at) candidate = { name: job.name, at: job.nextRunAt };
    }
    return candidate;
  }, [enabledJobs]);
  // 计划详情（下次运行+任务名 / 任务数 / 空态引导）只走 title 悬浮提示，
  // 待过目数量交给右侧角标——同一个数字绝不在行内和角标各讲一遍。
  // 行内保持与上行一致的单行节奏：标题 + 右槽下次运行时间。
  const pendingLabel = cz.automationPending.replace('{count}', String(pendingCount));
  const subtitle = nextJob
    ? cz.automationNext.replace('{time}', formatNextRun(nextJob.at, language === 'zh' ? 'zh-CN' : 'en-US')).replace('{name}', nextJob.name)
    : enabledJobs.length > 0
      ? cz.automationCount.replace('{count}', String(enabledJobs.length))
      : cz.automationEmpty;

  // pb-2 = 侧栏唯一的区间断点（入口区 ‖ 会话列表，8px）：
  // 入口行之间零间距等距排列，靠行本身的对齐表达同组，不再每层 pb-1 糊成一个面。
  return (
    <div className="px-2 pb-2 flex-shrink-0" data-testid="sidebar-capability-zone">
      {/* 能力中心入口 */}
      <button /* ds-allow:button: 侧栏能力区单行列表行（裸图标+标题+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => openCapabilityHub('experts')}
        data-testid="sidebar-capability-hub"
        // 「里面装了什么」移到悬浮提示：需要时问得到，不必占一行常驻
        title={cz.capabilityHubSubtitle}
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
      >
        {/* 裸图标（h-4，中性 zinc-500）：24px 底块瓦片三条叠起来是一条沉重的左边缘，
            颜色只留给「要你处理的地方」（待过目角标 + running 圆点）。 */}
        <Boxes className="h-4 w-4 flex-shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
          {cz.capabilityHub}
        </span>
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
      </button>
      {/* Batch 2 L3: 资料库槽位点亮 */}
      <button /* ds-allow:button: 侧栏能力区单行列表行（裸图标+标题+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => setShowLibraryPanel(true)}
        data-testid="sidebar-capability-library"
        title={cz.librarySubtitle}
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
      >
        <BookOpen className="h-4 w-4 flex-shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
          {cz.library}
        </span>
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
      </button>
      <button /* ds-allow:button: 侧栏能力区单行列表行（裸图标+标题+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => setShowCronCenter(true)}
        data-testid="sidebar-capability-automation"
        title={subtitle}
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
      >
        <span className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center text-zinc-500">
          <Clock3 className="h-4 w-4" />
          {runningCount > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400" data-testid="sidebar-capability-automation-running" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
          {cz.automation}
        </span>
        {nextJob && (
          <span className="flex-shrink-0 text-[11px] text-zinc-600 tabular-nums">
            {formatNextRun(nextJob.at, language === 'zh' ? 'zh-CN' : 'en-US')}
          </span>
        )}
        {/* 全栏唯一的两处彩色（这个角标 + running 圆点）= 要你处理的地方；
            裸数字自己说不清是什么，读屏靠 aria-label。 */}
        {pendingCount > 0 && <Badge className="border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-300" data-testid="sidebar-capability-automation-pending" role="status" aria-label={pendingLabel} title={pendingLabel}>{pendingCount}</Badge>}
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
      </button>
    </div>
  );
};
