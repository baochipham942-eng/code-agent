// ============================================================================
// MasterTaskCounter - 显示进行中 / 待审查 / 已完成的 MasterTask 数量
// ============================================================================
// 点击切到 Task Board (master-tasks workbench tab)
// 三个计数全为 0 时不渲染（不占用 StatusBar 空间）

import React, { useMemo } from 'react';
import { Play, Eye, CheckCircle2 } from 'lucide-react';
import type { MasterTaskDTO, MasterTaskStatus } from '@shared/contract/task';
import { useMasterTaskStore } from '../../stores/masterTaskStore';
import { useAppStore } from '../../stores/appStore';

// 'in_progress' 不在 MasterTaskStatus 字面量中，但保留作为防御性兼容（旧数据 / 上游 stub）
const IN_PROGRESS_STATUSES = ['running', 'in_progress'] as const;
const REVIEW_STATUSES = ['review'] as const;
const COMPLETED_STATUSES = ['completed', 'done'] as const;

/**
 * 纯函数：把 tasks 数组归类为 running / review / completed 计数。
 * 抽出来方便单测，不绑 React hook 上下文。
 */
export function computeMasterTaskCounts(tasks: MasterTaskDTO[]): {
  running: number;
  review: number;
  completed: number;
} {
  let running = 0;
  let review = 0;
  let completed = 0;
  for (const t of tasks) {
    const status = t.status as MasterTaskStatus | 'in_progress';
    if (IN_PROGRESS_STATUSES.includes(status as never)) {
      running++;
    } else if (REVIEW_STATUSES.includes(status as never)) {
      review++;
    } else if (COMPLETED_STATUSES.includes(status as never)) {
      completed++;
    }
  }
  return { running, review, completed };
}

/**
 * 纯函数：构造点击切到 Task Board 的副作用回调。抽出来方便单测，避免穿透 React render。
 * 用宽签名（接收 'master-tasks' 字面量）确保和 appStore 的 WorkbenchTabId 兼容。
 */
export function makeOpenTaskBoardHandler(
  openWorkbenchTab: (id: 'master-tasks') => void,
  setActiveWorkbenchTab: (id: 'master-tasks') => void,
): () => void {
  return () => {
    openWorkbenchTab('master-tasks');
    setActiveWorkbenchTab('master-tasks');
  };
}

export function MasterTaskCounter() {
  const tasks = useMasterTaskStore((s) => s.tasks);
  const openWorkbenchTab = useAppStore((s) => s.openWorkbenchTab);
  const setActiveWorkbenchTab = useAppStore((s) => s.setActiveWorkbenchTab);

  const { running, review, completed } = useMemo(() => computeMasterTaskCounts(tasks), [tasks]);

  if (running === 0 && review === 0 && completed === 0) {
    return null;
  }

  const onClick = makeOpenTaskBoardHandler(openWorkbenchTab, setActiveWorkbenchTab);

  return (
    <>
      <span className="text-gray-600">|</span>
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-2 text-gray-400 hover:text-gray-200 transition-colors"
        aria-label={`${running} running, ${review} reviewing, ${completed} completed master tasks`}
        title="Open Task Board"
      >
        {running > 0 && (
          <span className="flex items-center gap-1 text-sky-400">
            <Play size={12} />
            <span>{running}</span>
          </span>
        )}
        {review > 0 && (
          <span className="flex items-center gap-1 text-amber-400">
            <Eye size={12} />
            <span>{review}</span>
          </span>
        )}
        {completed > 0 && (
          <span className="flex items-center gap-1 text-emerald-400">
            <CheckCircle2 size={12} />
            <span>{completed}</span>
          </span>
        )}
      </button>
    </>
  );
}
