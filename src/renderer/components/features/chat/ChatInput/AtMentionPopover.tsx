// ============================================================================
// AtMentionPopover - @ 触发面板（WorkBuddy 形态，2026-07-29 UX round2 任务 14/15）
// ============================================================================
//
// 顶部 query echo（任务 15：输入可见性），下方两组列表：
// - 「资料库」：Pin 图标 + 标题 + 归属小字（本项目/全局），已 pin 的行显示 check；
//   选中 = 切换 pin 进本会话（面板保持打开，可连续带多条）。
// - 「工作区文件」：文件/文件夹图标 + 名称 + 所在目录第二行灰字；选中 = 插入 @path。
// 组标题 sticky 带计数；高亮行 data-selected + 滚动跟随。键盘逻辑在 useAtMentionPanel。

import React, { useEffect, useRef } from 'react';
import { BookOpen, Check, File as FileIcon, Folder, Pin } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import type { AtMentionFileRow, AtMentionLibraryRow, AtMentionRow } from './atMentionPanelModel';

interface AtMentionPopoverProps {
  query: string;
  libraryRows: AtMentionLibraryRow[];
  fileRows: AtMentionFileRow[];
  selectedIndex: number;
  onSelect: (row: AtMentionRow) => void;
  onHover: (index: number) => void;
}

export const AtMentionPopover: React.FC<AtMentionPopoverProps> = ({
  query,
  libraryRows,
  fileRows,
  selectedIndex,
  onSelect,
  onHover,
}) => {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const totalCount = libraryRows.length + fileRows.length;

  // 高亮行滚动跟随（同 SlashCommandPopover 的 data-selected 方案）
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const rowClass = (selected: boolean) => `w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors ${
    selected ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/70'
  }`;

  return (
    <div
      ref={listRef}
      data-at-mention-popover
      className="absolute bottom-full left-0 right-0 mb-1 elevation-l2 popover-enter rounded-lg z-20 max-h-[280px] overflow-y-auto"
    >
      {/* 任务 15：搜索可见性 —— query 非空回显结果数，空 query 提示可搜索 */}
      <div className="sticky top-0 z-10 elevation-l2 border-b border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500">
        {query.trim()
          ? t.mentionPanel.searchEcho.replace('{query}', query).replace('{count}', String(totalCount))
          : t.mentionPanel.emptyHintFileLibrary}
      </div>

      {libraryRows.length > 0 && (
        <div>
          <div className="sticky top-[30px] z-10 elevation-l2 px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
            {t.mentionPanel.libraryGroup} · {libraryRows.length}
          </div>
          {libraryRows.map((row, index) => (
            <button /* ds-allow:button: 面板候选行是图标+双行文字的整行热区，Button primitive 不适配 */
              key={`library:${row.item.id}`}
              type="button"
              data-selected={index === selectedIndex}
              onClick={() => onSelect(row)}
              onMouseEnter={() => onHover(index)}
              className={rowClass(index === selectedIndex)}
            >
              <Pin className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${row.pinned ? 'text-indigo-300' : 'text-zinc-600'}`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-xs">
                  <span className="truncate">{row.item.title}</span>
                  <span className="shrink-0 rounded bg-zinc-800 px-1 py-px text-[9px] text-zinc-500">
                    {row.item.projectId === null ? t.mentionPanel.globalScope : t.mentionPanel.projectScope}
                  </span>
                </span>
                <span className="block truncate text-[10px] text-zinc-500">
                  {row.item.summary || row.item.pathOrUri}
                </span>
              </span>
              {row.pinned && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-300" aria-label={t.mentionPanel.pinnedBadge} />}
            </button>
          ))}
        </div>
      )}

      {fileRows.length > 0 && (
        <div>
          <div className="sticky top-[30px] z-10 elevation-l2 px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
            {t.mentionPanel.filesGroup} · {fileRows.length}
          </div>
          {fileRows.map((row, fileIndex) => {
            const index = libraryRows.length + fileIndex;
            const Icon = row.isDirectory ? Folder : FileIcon;
            return (
              <button /* ds-allow:button: 面板候选行是图标+双行文字的整行热区，Button primitive 不适配 */
                key={`file:${row.path}`}
                type="button"
                data-selected={index === selectedIndex}
                onClick={() => onSelect(row)}
                onMouseEnter={() => onHover(index)}
                className={rowClass(index === selectedIndex)}
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{row.name}</span>
                  {row.dir && <span className="block truncate text-[10px] text-zinc-500">{row.dir}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {totalCount === 0 && (
        <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-zinc-600">
          <BookOpen className="h-3.5 w-3.5" />
          {t.mentionPanel.noResults}
        </div>
      )}
    </div>
  );
};
