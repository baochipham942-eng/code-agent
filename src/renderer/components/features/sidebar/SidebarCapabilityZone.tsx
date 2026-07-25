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
  // 副标题只讲「计划」，待过目数量交给右侧角标——此前 pending 时副标题写「N 条待过目」
  // 而角标同时显示 N，同一个数字讲了两遍，还把「下次运行」挤掉了。
  const pendingLabel = cz.automationPending.replace('{count}', String(pendingCount));
  const subtitle = nextJob
    ? cz.automationNext.replace('{time}', formatNextRun(nextJob.at, language === 'zh' ? 'zh-CN' : 'en-US')).replace('{name}', nextJob.name)
    : enabledJobs.length > 0
      ? cz.automationCount.replace('{count}', String(enabledJobs.length))
      : cz.automationEmpty;

  return (
    <div className="px-2 pb-1 flex-shrink-0" data-testid="sidebar-capability-zone">
      {/* 能力中心入口 */}
      <button /* ds-allow:button: 侧栏能力区列表行（两行文本+图标瓦片+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => openCapabilityHub('experts')}
        data-testid="sidebar-capability-hub"
        // 「里面装了什么」移到悬浮提示：需要时问得到，不必占一行常驻
        title={cz.capabilityHubSubtitle}
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
      >
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-zinc-800/80">
          <Boxes className="h-3.5 w-3.5 text-zinc-400" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
          {cz.capabilityHub}
        </span>
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
      </button>
      {/* Batch 2 L3: 资料库槽位点亮 */}
      <button /* ds-allow:button: 侧栏能力区列表行（两行文本+图标瓦片+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => setShowLibraryPanel(true)}
        data-testid="sidebar-capability-library"
        title={cz.librarySubtitle}
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
      >
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-zinc-800/80">
          <BookOpen className="h-3.5 w-3.5 text-zinc-400" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
          {cz.library}
        </span>
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
      </button>
      <button /* ds-allow:button: 侧栏能力区列表行（两行文本+图标瓦片+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => setShowCronCenter(true)}
        data-testid="sidebar-capability-automation"
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
      >
        <span className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-zinc-800/80">
          <Clock3 className="h-3.5 w-3.5 text-zinc-400" />
          {runningCount > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400" data-testid="sidebar-capability-automation-running" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-300 group-hover:text-zinc-100">{cz.automation}</span>
          <span className="block truncate text-[11px] text-zinc-500">{subtitle}</span>
        </span>
        {/* 全栏唯一的两处彩色（这个角标 + running 圆点）= 要你处理的地方；
            图标瓦片一律中性，颜色不再用来给四行分类。裸数字自己说不清是什么，读屏靠 aria-label。 */}
        {pendingCount > 0 && <Badge className="border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-300" data-testid="sidebar-capability-automation-pending" role="status" aria-label={pendingLabel} title={pendingLabel}>{pendingCount}</Badge>}
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
      </button>
    </div>
  );
};
