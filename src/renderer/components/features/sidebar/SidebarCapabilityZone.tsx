// ============================================================================
// SidebarCapabilityZone —— 侧栏能力区（会话列表上方的一等能力入口）。
// 三件套共用容器：自动化（本批点亮）/ 专家 / 资料库（后续批次各自点亮）。
// 数据只读复用 cronStore，不新增数据通道。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { Clock3, ChevronRight, BookOpen } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { sessionAutomationClient } from '../../../services/sessionAutomationClient';
import { Badge } from '../../primitives/Badge';

/** 下次运行时间：今天只显 HH:mm，其他日期带月日 */
function formatNextRun(ts: number, locale: string): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const day = date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
  return `${day} ${time}`;
}

export const SidebarCapabilityZone: React.FC = () => {
  const { t, language } = useI18n();
  const cz = t.sidebar.capabilityZone;
  const { showCronCenter, setShowCronCenter, setShowLibraryPanel } = useAppStore();
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
      if (!candidate || job.nextRunAt < candidate.at) {
        candidate = { name: job.name, at: job.nextRunAt };
      }
    }
    return candidate;
  }, [enabledJobs]);

  const subtitle = pendingCount > 0
    ? cz.automationPending.replace('{count}', String(pendingCount))
    : nextJob
    ? cz.automationNext
        .replace('{time}', formatNextRun(nextJob.at, language === 'zh' ? 'zh-CN' : 'en-US'))
        .replace('{name}', nextJob.name)
    : enabledJobs.length > 0
      ? cz.automationCount.replace('{count}', String(enabledJobs.length))
      : cz.automationEmpty;

  return (
    <div className="px-2 pb-1 flex-shrink-0" data-testid="sidebar-capability-zone">
      {/* Batch 2 L3: 资料库槽位点亮 */}
      <button /* ds-allow:button: 侧栏能力区列表行（两行文本+图标瓦片+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => setShowLibraryPanel(true)}
        data-testid="sidebar-capability-library"
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
      >
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-indigo-500/10">
          <BookOpen className="h-3.5 w-3.5 text-indigo-400/90" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-300 group-hover:text-zinc-100">
            {cz.library}
          </span>
          <span className="block truncate text-[11px] text-zinc-500">{cz.librarySubtitle}</span>
        </span>
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
      </button>
      <button /* ds-allow:button: 侧栏能力区列表行（两行文本+图标瓦片+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => setShowCronCenter(true)}
        data-testid="sidebar-capability-automation"
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
      >
        <span className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-amber-500/10">
          <Clock3 className="h-3.5 w-3.5 text-amber-400/90" />
          {runningCount > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400"
              data-testid="sidebar-capability-automation-running"
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-300 group-hover:text-zinc-100">
            {cz.automation}
          </span>
          <span className="block truncate text-[11px] text-zinc-500">{subtitle}</span>
        </span>
        {pendingCount > 0 && (
          <Badge
            className="border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-300"
            data-testid="sidebar-capability-automation-pending"
          >
            {pendingCount}
          </Badge>
        )}
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
      </button>
    </div>
  );
};
