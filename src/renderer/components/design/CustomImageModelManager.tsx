// ============================================================================
// CustomImageModelManager（自定义生图模型 · 借鉴项① frontend）
// ----------------------------------------------------------------------------
// registry UI：列出已添加的自定义 OpenAI 兼容生图端点（含已配置/未配置徽标 + 删除）
// + 新增表单（显示名 / Base URL / 模型名 / API Key / 可选成本）。落盘走 designFiles
// 的 WORKSPACE IPC 封装，后端 customImageModelRegistry + SSRF 守卫已完成。仅文生图。
//
// 拆成纯展示 CustomImageModelManagerView（吃 props，可 renderToStaticMarkup 单测，绕开
// zustand SSR getServerSnapshot 坑）+ 容器 CustomImageModelManager（接 useI18n / IPC / 状态）。
//
// 设计系统契约：只用 primitives（Modal/Button/Input/IconButton）+ token，不写裸 button。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Check } from 'lucide-react';
import { Modal, Button, Input, IconButton } from '../primitives';
import { useI18n } from '../../hooks/useI18n';
import type { Translations } from '../../i18n';
import {
  listCustomImageModels,
  saveCustomImageModel,
  deleteCustomImageModel,
  type CustomImageModelMeta,
} from './designFiles';

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

// ---------------------------------------------------------------------------
// 容器 —— 接 useI18n / IPC / 本地状态，挂在 Modal 里。
// ---------------------------------------------------------------------------
export interface CustomImageModelManagerProps {
  isOpen: boolean;
  onClose: () => void;
  /** 模型增删后通知父级刷新生图模型下拉，可选。 */
  onModelsChange?: () => void;
}

export const CustomImageModelManager: React.FC<CustomImageModelManagerProps> = ({ isOpen, onClose, onModelsChange }) => {
  const { t } = useI18n();
  const s = t.design.customModel;

  const [models, setModels] = useState<CustomImageModelMeta[]>([]);
  const [mode, setMode] = useState<'list' | 'form'>('list');
  const [form, setForm] = useState<CustomModelFormState>(emptyCustomModelForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    setModels(await listCustomImageModels());
  }, []);

  useEffect(() => {
    if (isOpen) {
      setMode('list');
      setError(undefined);
      void refresh();
    }
  }, [isOpen, refresh]);

  const handleCreate = useCallback(() => {
    setForm(emptyCustomModelForm());
    setError(undefined);
    setMode('form');
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm(s.deleteConfirm)) return;
      await deleteCustomImageModel(id);
      await refresh();
      onModelsChange?.();
    },
    [refresh, onModelsChange, s.deleteConfirm],
  );

  const handleSave = useCallback(async () => {
    // 前端轻校验（后端 + SSRF 守卫是权威）：必填项空则就地提示，不发 IPC。
    if (!form.label.trim()) { setError(s.nameRequired); return; }
    if (!form.baseUrl.trim()) { setError(s.baseUrlRequired); return; }
    if (!form.modelName.trim()) { setError(s.modelNameRequired); return; }
    if (!form.apiKey.trim()) { setError(s.apiKeyRequired); return; }
    const costNum = form.cost.trim() ? Number(form.cost) : undefined;
    setSaving(true);
    setError(undefined);
    const { id, error: saveError } = await saveCustomImageModel({
      label: form.label.trim(),
      baseUrl: form.baseUrl.trim(),
      modelName: form.modelName.trim(),
      apiKey: form.apiKey.trim(),
      ...(typeof costNum === 'number' && Number.isFinite(costNum) && costNum >= 0 ? { costCnyPerImage: costNum } : {}),
    });
    setSaving(false);
    if (!id) {
      setError(saveError || s.saveFailed);
      return;
    }
    setMode('list');
    await refresh();
    onModelsChange?.();
  }, [form, refresh, onModelsChange, s]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={s.title} size="lg">
      <CustomImageModelManagerView
        s={s}
        models={models}
        mode={mode}
        form={form}
        saving={saving}
        error={error}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onBack={() => setMode('list')}
        onFormChange={setForm}
        onSave={handleSave}
      />
    </Modal>
  );
};

export default CustomImageModelManager;
