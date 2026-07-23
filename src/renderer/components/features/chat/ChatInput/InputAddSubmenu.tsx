import React, { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { RoleInitialAvatar } from '../../expert/RoleInitialAvatar';
import { useI18n } from '../../../../hooks/useI18n';

export interface InputAddSubmenuItem {
  id: string;
  label: string;
  description?: string;
  selected?: boolean;
}

interface FooterAction {
  label: string;
  onClick: () => void;
}

interface InputAddSubmenuProps {
  items: InputAddSubmenuItem[];
  onSelect: (item: InputAddSubmenuItem) => void;
  footerActions: FooterAction[];
}

/** 输入框「+」菜单的能力二级面板，供专家、技能和连接器共用。 */
export const InputAddSubmenu: React.FC<InputAddSubmenuProps> = ({ items, onSelect, footerActions }) => {
  const { t } = useI18n();
  const [keyword, setKeyword] = useState('');
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  const filteredItems = useMemo(() => {
    if (!normalizedKeyword) return items;
    const matches = items
      .map((item, index) => ({
        item,
        index,
        labelMatch: item.label.toLocaleLowerCase().includes(normalizedKeyword),
        descriptionMatch: item.description?.toLocaleLowerCase().includes(normalizedKeyword) ?? false,
      }))
      .filter((item) => item.labelMatch || item.descriptionMatch);
    return matches
      .sort((left, right) => Number(right.labelMatch) - Number(left.labelMatch) || left.index - right.index)
      .map(({ item }) => item);
  }, [items, normalizedKeyword]);

  return (
    <div className="w-[300px] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 shadow-2xl">
      <label className="flex items-center gap-2 border-b border-zinc-700/60 px-3 py-2 text-zinc-500">
        <Search className="h-3.5 w-3.5 shrink-0" />
        <input
          autoFocus
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t.inputAddMenu.submenuSearchPlaceholder}
          aria-label={t.inputAddMenu.submenuSearchAria}
          className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
        />
      </label>
      <div className="max-h-[300px] overflow-y-auto py-1">
        {filteredItems.map((item) => (
          <button /* ds-allow:button: 二级面板选择行需承载头像、两行文字和选中状态，Button primitive 的居中按钮形态不适配 */
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-700/70"
          >
            <RoleInitialAvatar roleId={item.id} name={item.label} className="h-4 w-4 text-[8px]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-zinc-100">{item.label}</span>
              <span className="block truncate text-[10px] text-zinc-500">{item.description || t.inputAddMenu.submenuNoDescription}</span>
            </span>
            {item.selected && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-label={t.inputAddMenu.selectedAria} />}
          </button>
        ))}
        {filteredItems.length === 0 && (
          <div className="px-3 py-7 text-center text-xs text-zinc-500">
            {items.length === 0 ? t.inputAddMenu.submenuEmpty : t.inputAddMenu.submenuNoResults}
          </div>
        )}
      </div>
      {footerActions.length > 0 && (
        <div className="border-t border-zinc-700/60 py-1">
          {footerActions.map((action) => (
            <button /* ds-allow:button: 二级面板底部管理入口是完整宽度菜单行，Button primitive 不适配 */
              key={action.label}
              type="button"
              onClick={action.onClick}
              className="w-full px-3 py-2 text-left text-xs text-sky-300 hover:bg-zinc-700/70"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
