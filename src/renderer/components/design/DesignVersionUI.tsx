// 设计原型「版本」相关 UI（从 DesignWorkspace 抽出，控文件体积 < 1000 行）。
// 三个纯展示、prop 驱动组件 + 时间格式化助手：
//   VersionControl       —— 版本下拉：列历史快照，选一个进只读查看（backlog #4）。
//   ViewingBanner        —— 查看历史版本时的横幅：回滚到此 / 返回最新。
//   VersionComparePicker —— 版本对比选择器：勾两版进并排对比 + 定稿（设主版/淘汰）。
// 文案走 i18n（t.design.*），不硬编码。
import React, { useState } from 'react';
import { Clock, ChevronDown, RotateCcw, GitCompare } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import type { DesignVersion } from './designFiles';
import type { Variant } from './variantSpine';

const formatVersionTime = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** 版本下拉：列出当前原型的历史快照，选一个进入只读查看（backlog #4）。 */
export const VersionControl: React.FC<{
  versions: DesignVersion[];
  viewingPath: string | null;
  onView: (v: DesignVersion) => void;
  onBackToLatest: () => void;
}> = ({ versions, viewingPath, onView, onBackToLatest }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (versions.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <Clock className="h-3.5 w-3.5" />
        <span>
          {t.design.versionsTitle}（{versions.length}）
        </span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-white/[0.1] bg-zinc-900 p-1 shadow-2xl">
          <button
            type="button"
            onClick={() => {
              onBackToLatest();
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
              viewingPath === null ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-300 hover:bg-white/[0.04]'
            }`}
          >
            <span className="text-emerald-300">●</span>
            {t.design.versionLatest}
          </button>
          {versions.map((v, i) => (
            <button
              key={v.path}
              type="button"
              onClick={() => {
                onView(v);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                viewingPath === v.path ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-300 hover:bg-white/[0.04]'
              }`}
            >
              <span>v{versions.length - i}</span>
              <span className="text-zinc-500">{formatVersionTime(v.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** 查看历史版本时的横幅：回滚到此 / 返回最新。 */
export const ViewingBanner: React.FC<{ onRollback: () => void; onBackToLatest: () => void }> = ({
  onRollback,
  onBackToLatest,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
      <Clock className="h-3.5 w-3.5 shrink-0" />
      <span>{t.design.versionViewing}</span>
      <button
        type="button"
        onClick={onRollback}
        className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-amber-400/20 px-2.5 py-1 text-amber-100 hover:bg-amber-400/30"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t.design.versionRollback}
      </button>
      <button
        type="button"
        onClick={onBackToLatest}
        className="rounded-md border border-amber-400/30 px-2.5 py-1 text-amber-200 hover:bg-amber-400/10"
      >
        {t.design.versionBackToLatest}
      </button>
    </div>
  );
};

/**
 * 版本对比选择器：列活跃 proto 版本（含主版徽标），勾选两版进入并排对比。
 * 与 VersionControl（只读看历史/回滚）分工：本控件负责对比 + 定稿（设主版/淘汰）。
 */
export const VersionComparePicker: React.FC<{
  variants: Variant[];
  picked: string[];
  onToggle: (id: string) => void;
  onCompare: () => void;
}> = ({ variants, picked, onToggle, onCompare }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (variants.length < 2) return null; // 不足两版无可对比

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <GitCompare className="h-3.5 w-3.5" />
        <span>{t.design.compareBtn}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-white/[0.1] bg-zinc-900 p-1 shadow-2xl">
          <div className="max-h-56 overflow-y-auto">
            {variants.map((v, i) => {
              const checked = picked.includes(v.id);
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => onToggle(v.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                    checked ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-300 hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${
                        checked ? 'border-fuchsia-400 bg-fuchsia-400/80' : 'border-white/20'
                      }`}
                    >
                      {checked && <span className="text-[9px] text-white">✓</span>}
                    </span>
                    v{variants.length - i}
                    {v.pinned && (
                      <span className="rounded bg-emerald-500/80 px-1 text-[9px] text-white">
                        {t.design.mainVersion}
                      </span>
                    )}
                  </span>
                  <span className="text-zinc-500">{formatVersionTime(v.createdAt)}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={picked.length !== 2}
            onClick={() => {
              onCompare();
              setOpen(false);
            }}
            className="mt-1 w-full rounded-md bg-fuchsia-500/90 px-2 py-1.5 text-xs font-medium text-white hover:bg-fuchsia-500 disabled:opacity-40"
          >
            {t.design.compareBtn}
          </button>
        </div>
      )}
    </div>
  );
};
