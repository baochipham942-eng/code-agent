// ============================================================================
// VisualModelsSettings —— 「生成模型」设置 tab（生图 + 生视频）
// ----------------------------------------------------------------------------
// IA 原则：模型/端点的「配置」归设置页，设计页（DesignWorkspace）只负责「选择」已配置模型。
// 两段式：生图模型（内置只读 + 自定义端点 CRUD，出片已通）/ 生视频模型（内置只读 +
// 自定义端点 CRUD，配置层 only，出片待接入）。自定义端点的列表/表单复用 design 的
// CustomImageModelManagerView（纯展示、已 SSR 单测），通过 props 适配 image / video 两套。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../../hooks/useI18n';
import { Check } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { SettingsPage } from '../SettingsLayout';
import {
  CustomImageModelManagerView,
  emptyCustomModelForm,
  type CustomModelFormState,
} from '../../../design/CustomImageModelManager';
import {
  listCustomImageModels,
  saveCustomImageModel,
  deleteCustomImageModel,
  listCustomVideoModels,
  saveCustomVideoModel,
  deleteCustomVideoModel,
  type CustomImageModelMeta,
} from '../../../design/designFiles';

interface BuiltinRow {
  id: string;
  label: string;
  provider: string;
  available: boolean;
}

async function invokeList(action: 'listVisualImageModels' | 'listVisualVideoModels'): Promise<BuiltinRow[]> {
  try {
    const res = await window.domainAPI?.invoke<{ models: BuiltinRow[] }>(IPC_DOMAINS.WORKSPACE, action, {});
    if (res?.success && Array.isArray(res.data?.models)) {
      return res.data.models.map((m) => ({ id: m.id, label: m.label, provider: m.provider, available: m.available }));
    }
    return [];
  } catch {
    return [];
  }
}

// 内置模型只读列表：名称 + 已配置/未配置徽标（key 状态来自 listVisual*Models 的 available）。
const BuiltinModelList: React.FC<{
  title: string;
  rows: BuiltinRow[];
  availableBadge: string;
  unconfiguredBadge: string;
}> = ({ title, rows, availableBadge, unconfiguredBadge }) => (
  <div className="flex flex-col gap-2">
    <span className="text-xs font-medium text-zinc-300">{title}</span>
    <ul className="flex flex-col gap-1.5">
      {rows.map((m) => (
        <li
          key={m.id}
          className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2"
        >
          <span className="truncate text-sm text-zinc-200">{m.label}</span>
          {m.available ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
              <Check className="h-3 w-3" />
              {availableBadge}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              {unconfiguredBadge}
            </span>
          )}
        </li>
      ))}
    </ul>
  </div>
);

// 通用自定义端点管理器（列表 + 新增表单），复用 CustomImageModelManagerView。
// 通过注入的 list/save/delete 适配 image / video 两套 IPC；save 的 cost 字段名差异在适配层抹平。
interface CustomEndpointManagerProps {
  strings: React.ComponentProps<typeof CustomImageModelManagerView>['s'];
  list: () => Promise<CustomImageModelMeta[]>;
  save: (input: {
    label: string;
    baseUrl: string;
    modelName: string;
    apiKey: string;
    cost?: number;
  }) => Promise<{ id: string | null; error?: string }>;
  remove: (id: string) => Promise<boolean>;
  onChange?: () => void;
}

const CustomEndpointManager: React.FC<CustomEndpointManagerProps> = ({ strings: s, list, save, remove, onChange }) => {
  const [models, setModels] = useState<CustomImageModelMeta[]>([]);
  const [mode, setMode] = useState<'list' | 'form'>('list');
  const [form, setForm] = useState<CustomModelFormState>(emptyCustomModelForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => setModels(await list()), [list]);
  useEffect(() => { void refresh(); }, [refresh]);

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm(s.deleteConfirm)) return;
    await remove(id);
    await refresh();
    onChange?.();
  }, [remove, refresh, onChange, s.deleteConfirm]);

  const handleSave = useCallback(async () => {
    if (!form.label.trim()) { setError(s.nameRequired); return; }
    if (!form.baseUrl.trim()) { setError(s.baseUrlRequired); return; }
    if (!form.modelName.trim()) { setError(s.modelNameRequired); return; }
    if (!form.apiKey.trim()) { setError(s.apiKeyRequired); return; }
    const costNum = form.cost.trim() ? Number(form.cost) : undefined;
    setSaving(true);
    setError(undefined);
    const { id, error: saveError } = await save({
      label: form.label.trim(),
      baseUrl: form.baseUrl.trim(),
      modelName: form.modelName.trim(),
      apiKey: form.apiKey.trim(),
      ...(typeof costNum === 'number' && Number.isFinite(costNum) && costNum >= 0 ? { cost: costNum } : {}),
    });
    setSaving(false);
    if (!id) { setError(saveError || s.saveFailed); return; }
    setMode('list');
    await refresh();
    onChange?.();
  }, [form, save, refresh, onChange, s]);

  return (
    <CustomImageModelManagerView
      s={s}
      models={models}
      mode={mode}
      form={form}
      saving={saving}
      error={error}
      onCreate={() => { setForm(emptyCustomModelForm()); setError(undefined); setMode('form'); }}
      onDelete={handleDelete}
      onBack={() => setMode('list')}
      onFormChange={setForm}
      onSave={handleSave}
    />
  );
};

export const VisualModelsSettings: React.FC = () => {
  const { t } = useI18n();
  const s = t.settings.visualModels;
  const cm = t.design.customModel;
  // 视频自定义端点复用 image 表单文案，仅覆盖标题/副文案/成本单位/空态/提示。
  const videoStrings: typeof cm = {
    ...cm,
    open: s.videoTitle,
    title: s.videoTitle,
    subtitle: s.videoSubtitle,
    empty: s.videoEmpty,
    costLabel: s.videoCostLabel,
    baseUrlHint: s.videoBaseUrlHint,
  };

  const [builtinImage, setBuiltinImage] = useState<BuiltinRow[]>([]);
  const [builtinVideo, setBuiltinVideo] = useState<BuiltinRow[]>([]);

  const refreshBuiltins = useCallback(async () => {
    // 生图内置 = listVisualImageModels 里 provider !== 'custom' 的（自定义的归下方管理器）。
    const img = await invokeList('listVisualImageModels');
    setBuiltinImage(img.filter((m) => m.provider !== 'custom'));
    setBuiltinVideo(await invokeList('listVisualVideoModels'));
  }, []);
  useEffect(() => { void refreshBuiltins(); }, [refreshBuiltins]);

  return (
    <SettingsPage title={s.title} description={s.subtitle}>
      {/* ── 生图模型 ── */}
      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold text-zinc-100">{s.imageSection}</h4>
        <BuiltinModelList
          title={s.builtinTitle}
          rows={builtinImage}
          availableBadge={cm.availableBadge}
          unconfiguredBadge={cm.unconfiguredBadge}
        />
        <CustomEndpointManager
          strings={cm}
          list={listCustomImageModels}
          save={(input) =>
            saveCustomImageModel({
              label: input.label,
              baseUrl: input.baseUrl,
              modelName: input.modelName,
              apiKey: input.apiKey,
              ...(input.cost !== undefined ? { costCnyPerImage: input.cost } : {}),
            })
          }
          remove={deleteCustomImageModel}
          onChange={refreshBuiltins}
        />
      </section>

      {/* ── 生视频模型 ── */}
      <section className="flex flex-col gap-3 border-t border-zinc-800 pt-6">
        <h4 className="text-sm font-semibold text-zinc-100">{s.videoSection}</h4>
        <BuiltinModelList
          title={s.builtinTitle}
          rows={builtinVideo}
          availableBadge={cm.availableBadge}
          unconfiguredBadge={cm.unconfiguredBadge}
        />
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300/90">
          {s.videoPendingNote}
        </p>
        <CustomEndpointManager
          strings={videoStrings}
          list={listCustomVideoModels}
          save={(input) =>
            saveCustomVideoModel({
              label: input.label,
              baseUrl: input.baseUrl,
              modelName: input.modelName,
              apiKey: input.apiKey,
              ...(input.cost !== undefined ? { costCnyPerVideo: input.cost } : {}),
            })
          }
          remove={deleteCustomVideoModel}
        />
      </section>
    </SettingsPage>
  );
};

export default VisualModelsSettings;
