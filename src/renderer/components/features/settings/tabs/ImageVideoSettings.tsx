// ============================================================================
// ImageVideoSettings - 生成模型默认值配置（图像 / 视频）— ADR-027
// 模型列表唯一真源 = visualModels.ts，经 workspace 域 list IPC 拿可用性；默认值存 AppSettings.design。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { ImagePlay, Video } from 'lucide-react';
import type { AppSettings } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import { invokeDomain } from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';

interface VisualModelRow {
  id: string;
  label: string;
  provider: string;
  available: boolean;
}

export function ImageVideoSettings() {
  const [imageModels, setImageModels] = useState<VisualModelRow[]>([]);
  const [videoModels, setVideoModels] = useState<VisualModelRow[]>([]);
  const [defaultImageModelId, setDefaultImageModelId] = useState<string>('');
  const [defaultVideoModelId, setDefaultVideoModelId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get'),
      invokeDomain<{ models: VisualModelRow[] }>(IPC_DOMAINS.WORKSPACE, 'listVisualImageModels'),
      invokeDomain<{ models: VisualModelRow[] }>(IPC_DOMAINS.WORKSPACE, 'listVisualVideoModels'),
    ])
      .then(([settings, imgRes, vidRes]) => {
        if (cancelled) return;
        setImageModels(imgRes?.models ?? []);
        setVideoModels(vidRes?.models ?? []);
        setDefaultImageModelId(settings?.design?.defaultImageModelId ?? '');
        setDefaultVideoModelId(settings?.design?.defaultVideoModelId ?? '');
      })
      .catch(() => {
        if (!cancelled) toast.error('加载生成模型配置失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const design: NonNullable<AppSettings['design']> = {
        defaultImageModelId: defaultImageModelId || undefined,
        defaultVideoModelId: defaultVideoModelId || undefined,
      };
      await invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { settings: { design } });
      toast.success('生成模型默认值已保存');
    } catch (error) {
      toast.error(`保存失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-xs text-zinc-500">加载中…</div>;
  }

  const renderModelList = (
    models: VisualModelRow[],
    selected: string,
    onSelect: (id: string) => void,
    groupName: string,
  ) => (
    <div className="flex flex-col gap-2">
      {models.length === 0 && <div className="text-xs text-zinc-500">没有可用模型。</div>}
      {models.map((m) => {
        const isSelected = selected === m.id;
        return (
          <label
            key={m.id}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
              isSelected ? 'border-sky-500/40 bg-sky-500/5' : 'border-zinc-700 bg-zinc-900/60 hover:border-zinc-600'
            }`}
          >
            <input
              type="radio"
              name={groupName}
              checked={isSelected}
              onChange={() => onSelect(m.id)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-100">{m.label}</span>
                <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400">
                  {m.provider}
                </span>
                <span className={`text-[11px] ${m.available ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {m.available ? '已配 Key' : '需配 Key'}
                </span>
              </div>
            </div>
          </label>
        );
      })}
    </div>
  );

  return (
    <SettingsPage
      title="生成模型"
      description="为设计画布的图像 / 视频生成选择默认模型。生成模型按各 provider 计费，与通用任务（对话/代码）模型相互独立。标注「需配 Key」的需先在「权限与安全 / Service API Keys」配置对应 key。"
    >
      <SettingsSection
        title="默认图像生成模型"
        description="设计画布出图时的默认模型；在画布里手动切换过的不受此默认影响（画布选择优先）。"
      >
        <div className="mb-2 flex items-center gap-1.5 text-xs text-zinc-400">
          <ImagePlay className="h-3.5 w-3.5" /> 图像
        </div>
        {renderModelList(imageModels, defaultImageModelId, setDefaultImageModelId, 'design-image-model')}
      </SettingsSection>

      <SettingsSection
        title="默认视频生成模型"
        description="设计画布生成视频时的默认模型；画布里手动切换过的不受此默认影响。"
      >
        <div className="mb-2 flex items-center gap-1.5 text-xs text-zinc-400">
          <Video className="h-3.5 w-3.5" /> 视频
        </div>
        {renderModelList(videoModels, defaultVideoModelId, setDefaultVideoModelId, 'design-video-model')}
      </SettingsSection>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-100 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <span className="text-xs text-zinc-500">保存后，新打开的设计画布会以此为默认。</span>
      </div>
    </SettingsPage>
  );
}
