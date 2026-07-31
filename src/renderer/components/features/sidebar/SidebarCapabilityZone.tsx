// ============================================================================
// SidebarCapabilityZone —— 侧栏能力区（会话列表上方的一等能力入口）。
// 三个槽位：能力中心、资料库与自动化。
// 数据只读复用 cronStore，不新增数据通道。
// ============================================================================

import React, { useEffect, useMemo } from 'react';
import { Clock3, BookOpen, Boxes, FolderKanban } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { formatNextRun } from '../../../utils/formatNextRun';
import { SidebarDoctorAlert } from './SidebarDoctorAlert';

export const SidebarCapabilityZone: React.FC = () => {
  const { t, language } = useI18n();
  const cz = t.sidebar.capabilityZone;
  const { showCronCenter, showCapabilityHub, showLibraryPanel, showProjectSpacePage, expertDetailRoleId, openCapabilityHub, openProjectSpacePage, setShowCronCenter, setShowLibraryPanel } = useAppStore();
  // 二级页迁入右侧内容区后，返回语义 = 侧栏直接切换，所以这三行要能读出「我现在在哪」。
  // 专家详情是能力中心的下钻页，归到能力中心一栏亮。
  const activeRow = expertDetailRoleId || showCapabilityHub ? 'hub'
    : showLibraryPanel ? 'library'
    : showCronCenter ? 'automation'
    : showProjectSpacePage ? 'projects'
    : null;
  const rowClass = (key: 'hub' | 'library' | 'automation' | 'projects') => (
    `group flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors ${
      activeRow === key ? 'bg-zinc-800 text-zinc-100' : 'hover:bg-zinc-800/70'
    }`
  );
  const jobs = useCronStore((state) => state.jobs);
  const stats = useCronStore((state) => state.stats);
  const refresh = useCronStore((state) => state.refresh);

  useEffect(() => {
    // 面板关闭时任务大概率有变化，跟着刷新一次。
    if (showCronCenter) return;
    void refresh();
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
  // 计划详情只走 title 悬浮提示；侧栏行本身保持「图标 + 标题」的统一节奏。
  const subtitle = nextJob
    ? cz.automationNext.replace('{time}', formatNextRun(nextJob.at, language === 'zh' ? 'zh-CN' : 'en-US')).replace('{name}', nextJob.name)
    : enabledJobs.length > 0
      ? cz.automationCount.replace('{count}', String(enabledJobs.length))
      : cz.automationEmpty;

  // pb-2 = 入口区 ‖ 会话列表的区间断点（8px）；会话列表内三分区之间沿用同一 8px
  // （SidebarSessionList 外层 gap-2，批P 第五波① 统一垂直节奏）。
  // 入口行之间零间距等距排列，靠行本身的对齐表达同组，不再每层 pb-1 糊成一个面。
  return (
    <div className="px-1 pb-2 flex-shrink-0" data-testid="sidebar-capability-zone">
      {/* 能力中心入口 */}
      <button /* ds-allow:button: 侧栏能力区单行列表行（裸图标+标题+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => openCapabilityHub('experts')}
        data-testid="sidebar-capability-hub"
        aria-current={activeRow === 'hub' ? 'page' : undefined}
        // 「里面装了什么」移到悬浮提示：需要时问得到，不必占一行常驻
        title={cz.capabilityHubSubtitle}
        className={rowClass('hub')}
      >
        {/* 裸图标（h-4，中性 zinc-500）：24px 底块瓦片三条叠起来是一条沉重的左边缘，
            颜色只留给「要你处理的地方」（待过目角标 + running 圆点）。 */}
        <Boxes className="h-4 w-4 flex-shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
          {cz.capabilityHub}
        </span>
      </button>
      {/* 协作空间入口（批P）：爸 2026-07-30 拍板挪到能力中心下面 */}
      <button /* ds-allow:button: 侧栏能力区单行列表行（裸图标+标题+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => openProjectSpacePage()}
        data-testid="sidebar-capability-projects"
        aria-current={activeRow === 'projects' ? 'page' : undefined}
        title={t.projectSpace.sidebarSubtitle}
        className={rowClass('projects')}
      >
        <FolderKanban className="h-4 w-4 flex-shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
          {t.projectSpace.sidebarEntry}
        </span>
      </button>
      {/* Batch 2 L3: 资料库槽位点亮 */}
      <button /* ds-allow:button: 侧栏能力区单行列表行（裸图标+标题+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => setShowLibraryPanel(true)}
        data-testid="sidebar-capability-library"
        aria-current={activeRow === 'library' ? 'page' : undefined}
        title={cz.librarySubtitle}
        className={rowClass('library')}
      >
        <BookOpen className="h-4 w-4 flex-shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
          {cz.library}
        </span>
      </button>
      <button /* ds-allow:button: 侧栏能力区单行列表行（裸图标+标题+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => setShowCronCenter(true)}
        data-testid="sidebar-capability-automation"
        aria-current={activeRow === 'automation' ? 'page' : undefined}
        title={subtitle}
        className={rowClass('automation')}
      >
        <span className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center text-zinc-500">
          <Clock3 className="h-4 w-4" />
          {runningCount > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400" data-testid="sidebar-capability-automation-running" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">
          {cz.automation}
        </span>
      </button>
      {/* 诊断问题徽标行：仅启动静默快检有 fail 项时出现，全绿不打扰 */}
      <SidebarDoctorAlert />
    </div>
  );
};
