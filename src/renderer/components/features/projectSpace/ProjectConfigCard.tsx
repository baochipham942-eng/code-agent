// ============================================================================
// ProjectConfigCard —— 项目配置右栏的通用卡片（专家/技能/连接器/自动化共用）。
// 结构：标题 +「+」+ 已选 chip 列表（每个带移除 ×）+「添加」弹窗（搜索 + 两行列表项）。
// 交互（批P 审美关 2026-07-30）：
// - 整卡可点打开添加弹窗：role=button + tabIndex + Enter/Space 键盘可达；
//   卡内「+」与 chip 删除 × 各自 stopPropagation，点它们不触发卡面点击。
// - 弹窗顶部搜索框本地过滤（名称+描述都搜）；列表项两行 = 名称 + 描述，描述空则单行降级。
// - 只读卡（如技能在非本项目工作目录）整卡不可点，「+」禁用态 + tooltip 说明原因
//   （房规：能力不可用要降级提示，不是消失），hint 不进卡身，避免卡高不齐。
// ============================================================================

import React, { useMemo, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { Badge } from '../../primitives/Badge';
import { IconButton } from '../../primitives/IconButton';
import { Input } from '../../primitives/Input';
import { Modal } from '../../primitives/Modal';
import { RoleIcon } from '../shared/RoleIcon';

interface ConfigCardItem {
  id: string;
  label: string;
  /** 弹窗列表项第二行（描述）；空则单行降级（连接器无描述字段，只列 label） */
  description?: string;
  /** 列表项左图标（专家：RolePanelEntry.icon 的 lucide 名，缺省 RoleIcon 自兜底） */
  icon?: string;
}

export interface ProjectConfigCardProps {
  testId: string;
  title: string;
  addLabel: string;
  removeLabel: string;
  selectedEmptyLabel: string;
  pickerEmptyLabel: string;
  pickerSearchPlaceholder: string;
  pickerNoMatchLabel: string;
  selected: ConfigCardItem[];
  options: ConfigCardItem[];
  onSelect: (id: string) => void;
  /** 省略 = 只读（整卡不可点，「+」禁用态 + title 说明原因） */
  onRemove?: (id: string) => void;
  /** 只读原因：用作「+」禁用态的 title/tooltip（不进卡身，避免四卡高度不齐） */
  readOnlyHint?: string | null;
}

export const ProjectConfigCard: React.FC<ProjectConfigCardProps> = ({
  testId,
  title,
  addLabel,
  removeLabel,
  selectedEmptyLabel,
  pickerEmptyLabel,
  pickerSearchPlaceholder,
  pickerNoMatchLabel,
  selected,
  options,
  onSelect,
  onRemove,
  readOnlyHint = null,
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const readOnly = !onRemove;

  const openPicker = () => {
    if (readOnly) return;
    setQuery('');
    setPickerOpen(true);
  };

  const filteredOptions = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return options;
    return options.filter((option) => (
      option.label.toLowerCase().includes(keyword)
      || (option.description ?? '').toLowerCase().includes(keyword)
    ));
  }, [options, query]);

  return (
    <section
      className={`rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3 ${
        readOnly ? '' : 'cursor-pointer transition-colors hover:border-zinc-700'
      }`}
      data-testid={testId}
      role={readOnly ? undefined : 'button'}
      tabIndex={readOnly ? undefined : 0}
      aria-label={readOnly ? undefined : `${addLabel} · ${title}`}
      onClick={readOnly ? undefined : openPicker}
      onKeyDown={readOnly ? undefined : (event) => {
        // 只响应卡在焦上的按键；「+」/chip × 等内嵌控件的键盘事件走它们自己
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPicker();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{title}</h3>
        <IconButton
          size="sm"
          variant="ghost"
          icon={<Plus className="h-3.5 w-3.5" />}
          aria-label={addLabel}
          title={readOnly ? (readOnlyHint ?? addLabel) : addLabel}
          disabled={readOnly}
          data-testid={`${testId}-add`}
          onClick={(event) => {
            event.stopPropagation();
            openPicker();
          }}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" data-testid={`${testId}-selected`}>
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
                  onClick={(event) => {
                    // 点删除是移除已选，不能冒泡成卡面点击弹弹窗
                    event.stopPropagation();
                    onRemove(item.id);
                  }}
                />
              ) : null}
            </Badge>
          ))
        )}
      </div>
      <Modal isOpen={pickerOpen} onClose={() => setPickerOpen(false)} title={`${addLabel} · ${title}`} size="sm">
        <div className="grid gap-2" data-testid={`${testId}-picker`}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={pickerSearchPlaceholder}
              className="pl-8"
              data-testid={`${testId}-search`}
            />
          </div>
          <div className="grid gap-1">
            {options.length === 0 ? (
              <p className="py-4 text-center text-sm text-zinc-500">{pickerEmptyLabel}</p>
            ) : filteredOptions.length === 0 ? (
              <p className="py-4 text-center text-sm text-zinc-500" data-testid={`${testId}-picker-no-match`}>{pickerNoMatchLabel}</p>
            ) : (
              filteredOptions.map((option) => (
                <button /* ds-allow:button: 添加弹窗选项行（图标+名称/描述两行左对齐列表行），Button primitive 是居中动作按钮形状，变体不适配列表行 */
                  key={option.id}
                  type="button"
                  data-testid={`${testId}-option-${option.id}`}
                  onClick={() => {
                    setPickerOpen(false);
                    onSelect(option.id);
                  }}
                  className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-zinc-800/70"
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
      </Modal>
    </section>
  );
};
