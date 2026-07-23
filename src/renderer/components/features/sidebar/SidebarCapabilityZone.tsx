// ============================================================================
// SidebarCapabilityZone —— 侧栏能力区（会话列表上方的一等能力入口）。
// 两个槽位：能力中心（专家 / 自动化 / 技能 / 连接器 / 插件，ADR-049）与资料库。
// 自动化不再单列一行——它是能力中心的一个 tab，并列会变成第二个入口；
// 它的实时信号（运行中 / 待过目）挂在能力中心行上，不丢提醒。
// 数据只读复用 cronStore，不新增数据通道。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { ChevronRight, BookOpen, Boxes } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { sessionAutomationClient } from '../../../services/sessionAutomationClient';
import { Badge } from '../../primitives/Badge';

export const SidebarCapabilityZone: React.FC = () => {
  const { t } = useI18n();
  const cz = t.sidebar.capabilityZone;
  const { showCapabilityHub, openCapabilityHub, setShowLibraryPanel } = useAppStore();
  const stats = useCronStore((state) => state.stats);
  const refresh = useCronStore((state) => state.refresh);

  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    // 面板关闭时任务/待审大概率有变化，跟着刷新一次
    if (showCapabilityHub) return;
    void refresh();
    sessionAutomationClient.countPendingReview()
      .then((count) => setPendingCount(count ?? 0))
      .catch(() => setPendingCount(0));
  }, [showCapabilityHub, refresh]);

  const runningCount = stats?.jobsByStatus?.running ?? 0;

  return (
    <div className="px-2 pb-1 flex-shrink-0" data-testid="sidebar-capability-zone">
      {/* 能力中心入口（ADR-049：五项能力唯一的家） */}
      <button /* ds-allow:button: 侧栏能力区列表行（两行文本+图标瓦片+chevron 左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={() => openCapabilityHub('experts')}
        data-testid="sidebar-capability-hub"
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
      >
        <span className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-violet-500/10">
          <Boxes className="h-3.5 w-3.5 text-violet-400/90" />
          {runningCount > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400"
              data-testid="sidebar-capability-automation-running"
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-300 group-hover:text-zinc-100">
            {cz.capabilityHub}
          </span>
          <span className="block truncate text-[11px] text-zinc-500">{cz.capabilityHubSubtitle}</span>
        </span>
        {pendingCount > 0 && (
          <Badge
            className="border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-300"
            title={cz.automationPending.replace('{count}', String(pendingCount))}
            data-testid="sidebar-capability-automation-pending"
          >
            {pendingCount}
          </Badge>
        )}
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400" />
      </button>
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
    </div>
  );
};
