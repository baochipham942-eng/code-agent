// ============================================================================
// ProjectConfigTabPanel —— 空间右栏 tab 的全高内容（专家/技能/连接器/自动化共用）。
// 形态（批P 返工第二波，弹窗形态废弃）：已选/可选同屏——
//   顶部搜索框（本地过滤 名称+描述）→ 已选 chip 区（每个带移除 ×）→ 可选列表（点击即选用）。
// 交互逻辑沿用第一波⑤：搜索过滤、displayName/description 两行项（描述空则单行降级）、
// chip 删除；不再有卡面点击/冒泡问题（整卡可点随卡片形态一起退场）。
// 只读态（如技能在无工作目录空间）：选项行禁用 + hint 内联降级提示
// （房规：能力不可用要降级提示，不是消失；tab 全高区有地方放，不必再挤 tooltip）。
// ============================================================================

import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Badge } from '../../primitives/Badge';
import { IconButton } from '../../primitives/IconButton';
import { Input } from '../../primitives/Input';
import { RoleIcon } from '../shared/RoleIcon';

interface ProjectConfigTabItem {
  id: string;
  label: string;
  /** 可选列表项第二行（描述）；空则单行降级（连接器无描述字段，只列 label） */
  description?: string;
  /** 列表项左图标（专家：RolePanelEntry.icon 的 lucide 名，缺省 RoleIcon 自兜底） */
  icon?: string;
}

export interface ProjectConfigTabPanelProps {
  testId: string;
  removeLabel: string;
  selectedEmptyLabel: string;
  optionsEmptyLabel: string;
  searchPlaceholder: string;
  noMatchLabel: string;
  selected: ProjectConfigTabItem[];
  options: ProjectConfigTabItem[];
  onSelect: (id: string) => void;
  /** 省略 = 只读：选项行禁用、chip 无 ×、hint 内联降级提示 */
  onRemove?: (id: string) => void;
  /** 只读原因：内联展示在已选区下方 */
  readOnlyHint?: string | null;
}

export const ProjectConfigTabPanel: React.FC<ProjectConfigTabPanelProps> = ({
  testId,
  removeLabel,
  selectedEmptyLabel,
  optionsEmptyLabel,
  searchPlaceholder,
  noMatchLabel,
  selected,
  options,
  onSelect,
  onRemove,
  readOnlyHint = null,
}) => {
  const [query, setQuery] = useState('');
  const readOnly = !onRemove;

  const filteredOptions = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return options;
    return options.filter((option) => (
      option.label.toLowerCase().includes(keyword)
      || (option.description ?? '').toLowerCase().includes(keyword)
    ));
  }, [options, query]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={testId}>
      <div className="shrink-0 px-3 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="pl-8"
            data-testid={`${testId}-search`}
          />
        </div>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {/* 已选在上（可移除） */}
        <div className="flex flex-wrap gap-1.5" data-testid={`${testId}-selected`}>
          {selected.length === 0 ? (
            <span className="text-xs text-zinc-600">{selectedEmptyLabel}</span>
          ) : (
            selected.map((item) => (
              <Badge key={item.id} className="border-zinc-700 bg-zinc-800/70 text-[11px] text-zinc-300" data-testid={`${testId}-chip-${item.id}`}>
                {item.label}
                {onRemove ? (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    icon={<X className="h-3 w-3" />}
                    aria-label={`${removeLabel} ${item.label}`}
                    data-testid={`${testId}-remove-${item.id}`}
                    onClick={() => onRemove(item.id)}
                  />
                ) : null}
              </Badge>
            ))
          )}
        </div>
        {readOnly && readOnlyHint ? (
          <p className="mt-2 text-xs text-zinc-500" data-testid={`${testId}-readonly-hint`}>{readOnlyHint}</p>
        ) : null}
        {/* 可选列表在下（搜索过滤后点击即选用） */}
        <div className="mt-3 grid gap-1" data-testid={`${testId}-options`}>
          {options.length === 0 ? (
            <p className="py-4 text-center text-sm text-zinc-500">{optionsEmptyLabel}</p>
          ) : filteredOptions.length === 0 ? (
            <p className="py-4 text-center text-sm text-zinc-500" data-testid={`${testId}-no-match`}>{noMatchLabel}</p>
          ) : (
            filteredOptions.map((option) => (
              <button /* ds-allow:button: 可选用行（图标+名称/描述两行左对齐列表行），Button primitive 是居中动作按钮形状，变体不适配列表行 */
                key={option.id}
                type="button"
                data-testid={`${testId}-option-${option.id}`}
                disabled={readOnly}
                onClick={() => onSelect(option.id)}
                className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-zinc-800/70 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                {option.icon !== undefined && (
                  <RoleIcon name={option.icon} className="h-4 w-4 flex-shrink-0 text-zinc-500" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-300">{option.label}</span>
                  {option.description ? (
                    <span className="mt-0.5 block truncate text-xs text-zinc-500">{option.description}</span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
