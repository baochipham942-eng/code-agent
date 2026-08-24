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
import { BookOpen, Check, File as FileIcon, FileOutput, Folder, History, Pin } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { formatRelativeTime } from '../../../../utils/i18nTime';
import {
  AT_MENTION_TABS,
  type AtMentionArtifactRow,
  type AtMentionFileRow,
  type AtMentionLibraryRow,
  type AtMentionRow,
  type AtMentionSessionRow,
  type AtMentionTab,
} from './atMentionPanelModel';

interface AtMentionPopoverProps {
  query: string;
  libraryRows: AtMentionLibraryRow[];
  fileRows: AtMentionFileRow[];
  sessionRows: AtMentionSessionRow[];
  artifactRows: AtMentionArtifactRow[];
  activeTab: AtMentionTab;
  selectedIndex: number;
  onTabChange: (tab: AtMentionTab) => void;
  onSelect: (row: AtMentionRow) => void;
  onHover: (index: number) => void;
}

export const AtMentionPopover: React.FC<AtMentionPopoverProps> = ({
  query,
  libraryRows,
  fileRows,
  sessionRows,
  artifactRows,
  activeTab,
  selectedIndex,
  onTabChange,
  onSelect,
  onHover,
}) => {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const totalCount = libraryRows.length + fileRows.length + sessionRows.length + artifactRows.length;

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
          : t.mentionPanel.emptyHint}
      </div>

      <div role="tablist" aria-label={t.mentionPanel.tabsAria} className="sticky top-[30px] z-10 flex elevation-l2 border-b border-zinc-800 px-1 py-1">
        {AT_MENTION_TABS.map((tab) => (
          <button /* ds-allow:button: 紧凑型面板 tab，无对应 Button primitive */
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onTabChange(tab)}
            className={`min-w-0 flex-1 truncate rounded px-1 py-1 text-[10px] transition-colors ${
              activeTab === tab ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.mentionPanel.tabs[tab]}
          </button>
        ))}
      </div>

      {libraryRows.length > 0 && (
        <div>
          <div className="sticky top-[58px] z-10 elevation-l2 px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
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
              <Pin className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${row.pinned ? 'text-badge-accent' : 'text-zinc-600'}`} />
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
              {row.pinned && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-badge-accent" aria-label={t.mentionPanel.pinnedBadge} />}
            </button>
          ))}
        </div>
      )}

      {fileRows.length > 0 && (
        <div>
          <div className="sticky top-[58px] z-10 elevation-l2 px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
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

      {sessionRows.length > 0 && (
        <div>
          <div className="sticky top-[58px] z-10 elevation-l2 px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
            {t.mentionPanel.sessionsGroup} · {sessionRows.length}
          </div>
          {sessionRows.map((row, sessionIndex) => {
            const index = libraryRows.length + fileRows.length + sessionIndex;
            return (
              <button /* ds-allow:button: 面板候选行是图标+双行文字的整行热区 */
                key={`session:${row.id}`}
                type="button"
                data-selected={index === selectedIndex}
                onClick={() => onSelect(row)}
                onMouseEnter={() => onHover(index)}
                className={rowClass(index === selectedIndex)}
              >
                <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{row.title}</span>
                  <span className="block truncate text-[10px] text-zinc-500">
                    {t.mentionPanel.sessionMeta
                      .replace('{time}', formatRelativeTime(t, row.updatedAt))
                      .replace('{count}', String(row.messageCount))
                      .replace('{project}', row.projectName || t.mentionPanel.unknownProject)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {artifactRows.length > 0 && (
        <div>
          <div className="sticky top-[58px] z-10 elevation-l2 px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
            {t.mentionPanel.artifactsGroup} · {artifactRows.length}
          </div>
          {artifactRows.map((row, artifactIndex) => {
            const index = libraryRows.length + fileRows.length + sessionRows.length + artifactIndex;
            return (
              <button /* ds-allow:button: 面板候选行是图标+双行文字的整行热区 */
                key={`artifact:${row.id}`}
                type="button"
                data-selected={index === selectedIndex}
                onClick={() => onSelect(row)}
                onMouseEnter={() => onHover(index)}
                className={rowClass(index === selectedIndex)}
              >
                <FileOutput className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-xs">
                    <span className="truncate">{row.name}</span>
                    <span className="shrink-0 rounded bg-zinc-800 px-1 py-px text-[9px] text-zinc-500">
                      {t.mentionPanel.artifactTypes[row.artifactType]}
                    </span>
                  </span>
                  <span className="block truncate text-[10px] text-zinc-500">
                    {t.mentionPanel.artifactMeta
                      .replace('{session}', row.sessionTitle || t.mentionPanel.unknownSession)
                      .replace('{time}', formatRelativeTime(t, row.createdAt))}
                  </span>
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
