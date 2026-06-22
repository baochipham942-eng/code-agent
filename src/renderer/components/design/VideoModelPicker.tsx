// 设计模式「视频模型」下拉。按当前 videoMode(t2v/i2v) 过滤 cap，provider key 未配置的灰显。
// 拆「展示组件 View（吃 props，纯渲染）+ 容器（接 IPC + designStore）」：
// View 无 store/hook 依赖，便于无 jsdom 环境下 renderToStaticMarkup 真组件做 dogfood/视觉验证，
// 绕开 SSR zustand getServerSnapshot 的坑（对齐 ImageModelPicker 拆法）。
import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';

export interface VideoModelOption {
  id: string;
  label: string;
  available: boolean;
  caps: string[];
}

export interface VideoModelPickerViewProps {
  models: VideoModelOption[];
  value: string;
  onChange: (id: string) => void;
  /** 未配置 key 的 option 后缀文案（由容器经 i18n 注入，便于 SSR 测试）。 */
  unconfiguredLabel: string;
  ariaLabel?: string;
}

export const VideoModelPickerView: React.FC<VideoModelPickerViewProps> = ({
  models,
  value,
  onChange,
  unconfiguredLabel,
  ariaLabel,
}) => {
  return (
    <select
      data-testid="design-video-model"
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-white/[0.10] bg-white/[0.04] px-2 py-1 text-xs text-zinc-200 focus:border-white/[0.3] focus:outline-none"
    >
      {models.map((m) => (
        <option
          key={m.id}
          value={m.id}
          disabled={!m.available}
          className={m.available ? '' : 'text-zinc-500'}
        >
          {m.available ? m.label : `${m.label}（${unconfiguredLabel}）`}
        </option>
      ))}
    </select>
  );
};

/** 容器：拉视频模型可用性（IPC），按 videoMode 过滤 cap，接 designStore 读写当前选中。 */
export const VideoModelPicker: React.FC = () => {
  const { t } = useI18n();
  const videoModel = useDesignStore((s) => s.videoModel);
  const videoMode = useDesignStore((s) => s.videoMode);
  const setVideoModel = useDesignStore((s) => s.setVideoModel);
  const [models, setModels] = useState<VideoModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await window.domainAPI?.invoke<{ models: VideoModelOption[] }>(
        IPC_DOMAINS.WORKSPACE,
        'listVisualVideoModels',
      );
      if (!cancelled && res?.success && res.data?.models) setModels(res.data.models);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = models.filter((m) => m.caps.includes(videoMode));
  // 切换 mode 后若当前选中模型不支持该 cap，自动落到第一个可选项（避免选中态与 mode 不一致）。
  // 在 effect 内重算过滤列表（不依赖每渲染重建的 filtered，避免重渲染循环）。
  useEffect(() => {
    const inMode = models.filter((m) => m.caps.includes(videoMode));
    if (inMode.length > 0 && !inMode.some((m) => m.id === videoModel)) {
      setVideoModel(inMode[0].id);
    }
  }, [videoMode, models, videoModel, setVideoModel]);

  return (
    <VideoModelPickerView
      models={filtered}
      value={videoModel}
      onChange={setVideoModel}
      unconfiguredLabel={t.design.videoModelUnconfigured}
      ariaLabel={t.design.videoModel}
    />
  );
};
