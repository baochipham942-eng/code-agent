// ============================================================================
// ProjectConfigCard —— 项目配置右栏的通用卡片（专家/技能/连接器/自动化共用）。
// 结构：标题 +「去配置」深链 + 已选 chip 列表（每个带移除 ×）+「添加」弹层（Modal，点击即选）。
// ============================================================================

import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Badge } from '../../primitives/Badge';
import { GhostButton } from '../../primitives/Button';
import { IconButton } from '../../primitives/IconButton';
import { Modal } from '../../primitives/Modal';

export interface ConfigCardItem {
  id: string;
  label: string;
}

export interface ProjectConfigCardProps {
  testId: string;
  title: string;
  configureLabel: string;
  onConfigure: () => void;
  addLabel: string;
  removeLabel: string;
  selectedEmptyLabel: string;
  pickerEmptyLabel: string;
  selected: ConfigCardItem[];
  options: ConfigCardItem[];
  onSelect: (id: string) => void;
  /** 省略 = 只读（不画移除 ×、不开放添加） */
  onRemove?: (id: string) => void;
  readOnlyHint?: string | null;
}

export const ProjectConfigCard: React.FC<ProjectConfigCardProps> = ({
  testId,
  title,
  configureLabel,
  onConfigure,
  addLabel,
  removeLabel,
  selectedEmptyLabel,
  pickerEmptyLabel,
  selected,
  options,
  onSelect,
  onRemove,
  readOnlyHint = null,
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const readOnly = !onRemove;

  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3" data-testid={testId}>
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{title}</h3>
        <GhostButton size="sm" onClick={onConfigure} data-testid={`${testId}-configure`}>
          {configureLabel}
        </GhostButton>
        {!readOnly && (
          <IconButton
            size="sm"
            variant="ghost"
            icon={<Plus className="h-3.5 w-3.5" />}
            aria-label={addLabel}
            title={addLabel}
            data-testid={`${testId}-add`}
            onClick={() => setPickerOpen(true)}
          />
        )}
      </div>
      {readOnlyHint ? <p className="mt-1.5 text-xs leading-5 text-zinc-600">{readOnlyHint}</p> : null}
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
                  onClick={() => onRemove(item.id)}
                />
              ) : null}
            </Badge>
          ))
        )}
      </div>
      <Modal isOpen={pickerOpen} onClose={() => setPickerOpen(false)} title={`${addLabel} · ${title}`} size="sm">
        <div className="grid gap-1" data-testid={`${testId}-picker`}>
          {options.length === 0 ? (
            <p className="py-4 text-center text-sm text-zinc-500">{pickerEmptyLabel}</p>
          ) : (
            options.map((option) => (
              <button /* ds-allow:button: 添加弹层选项行（整行可点列表行），Button primitive 是居中动作按钮形状，变体不适配列表行 */
                key={option.id}
                type="button"
                data-testid={`${testId}-option-${option.id}`}
                onClick={() => {
                  setPickerOpen(false);
                  onSelect(option.id);
                }}
                className="w-full truncate rounded-lg px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-800/70 hover:text-zinc-100"
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      </Modal>
    </section>
  );
};

export default ProjectConfigCard;
