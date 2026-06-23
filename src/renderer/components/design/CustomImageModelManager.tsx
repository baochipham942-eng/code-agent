// ============================================================================
// CustomImageModelManagerView（自定义生图/视频端点管理 · 纯展示 View）
// ----------------------------------------------------------------------------
// registry UI：列出已添加的自定义端点（含已配置/未配置徽标 + 删除）+ 新增表单
// （显示名 / Base URL / 模型名 / API Key / 可选成本）。纯展示、吃 props，可
// renderToStaticMarkup 单测（绕开 zustand SSR getServerSnapshot 坑）。
//
// 容器逻辑（接 IPC / 状态）由调用方提供：设置页「生成模型」tab 的 VisualModelsSettings
// 用它管理 image / video 两套自定义端点（IA：模型配置归设置页，设计页只选不配）。
//
// 设计系统契约：只用 primitives（Button/Input/IconButton）+ token，不写裸 button。
// ============================================================================

import React from 'react';
import { Plus, Trash2, Check } from 'lucide-react';
import { Button, Input, IconButton } from '../primitives';
import type { Translations } from '../../i18n';
import type { CustomImageModelMeta } from './designFiles';

type CustomModelStrings = Translations['design']['customModel'];

export interface CustomModelFormState {
  label: string;
  baseUrl: string;
  modelName: string;
  apiKey: string;
  /** 成本字符串（可空），保存时 parseFloat。 */
  cost: string;
}

export function emptyCustomModelForm(): CustomModelFormState {
  return { label: '', baseUrl: '', modelName: '', apiKey: '', cost: '' };
}

// ---------------------------------------------------------------------------
// 纯展示 View —— props 驱动，可 SSR 单测。
// ---------------------------------------------------------------------------
export interface CustomImageModelManagerViewProps {
  s: CustomModelStrings;
  models: CustomImageModelMeta[];
  mode: 'list' | 'form';
  form: CustomModelFormState;
  saving: boolean;
  error?: string;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onBack: () => void;
  onFormChange: (next: CustomModelFormState) => void;
  onSave: () => void;
}

export const CustomImageModelManagerView: React.FC<CustomImageModelManagerViewProps> = ({
  s,
  models,
  mode,
  form,
  saving,
  error,
  onCreate,
  onDelete,
  onBack,
  onFormChange,
  onSave,
}) => {
  if (mode === 'form') {
    return (
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-zinc-300">{s.nameLabel}</span>
          <Input
            value={form.label}
            placeholder={s.namePlaceholder}
            onChange={(e) => onFormChange({ ...form, label: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-zinc-300">{s.baseUrlLabel}</span>
          <Input
            value={form.baseUrl}
            placeholder={s.baseUrlPlaceholder}
            onChange={(e) => onFormChange({ ...form, baseUrl: e.target.value })}
          />
          <span className="text-[11px] text-zinc-500">{s.baseUrlHint}</span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-zinc-300">{s.modelNameLabel}</span>
          <Input
            value={form.modelName}
            placeholder={s.modelNamePlaceholder}
            onChange={(e) => onFormChange({ ...form, modelName: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-zinc-300">{s.apiKeyLabel}</span>
          <Input
            type="password"
            value={form.apiKey}
            placeholder={s.apiKeyPlaceholder}
            onChange={(e) => onFormChange({ ...form, apiKey: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-zinc-300">{s.costLabel}</span>
          <Input
            inputMode="decimal"
            value={form.cost}
            placeholder={s.costPlaceholder}
            onChange={(e) => onFormChange({ ...form, cost: e.target.value })}
          />
        </label>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            {s.back}
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={onSave}>
            {saving ? s.saving : s.save}
          </Button>
        </div>
      </div>
    );
  }

  // 列表模式
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-zinc-400">{s.subtitle}</p>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">{s.listTitle}</span>
        <Button variant="secondary" size="sm" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={onCreate}>
          {s.create}
        </Button>
      </div>

      {models.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-700 px-4 py-6 text-center text-xs text-zinc-500">
          {s.empty}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {models.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-800/40 px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-zinc-200">{m.label}</span>
                <span className="truncate text-[11px] text-zinc-500">{m.modelName} · {m.baseUrl}</span>
              </div>
              {m.available ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                  <Check className="h-3 w-3" />
                  {s.availableBadge}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                  {s.unconfiguredBadge}
                </span>
              )}
              <IconButton
                variant="ghost"
                size="sm"
                aria-label={s.delete}
                title={s.delete}
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={() => onDelete(m.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
