// 设计模式「生图模型」下拉。列出全部视觉生图模型，provider key 未配置的灰显 + 标注未配置。
// 拆成「展示组件 View（吃 props，纯渲染）+ 容器（接 IPC + designStore）」：
// View 无 store/hook 依赖，便于无 jsdom 环境下 renderToStaticMarkup 真组件做 dogfood/视觉验证，
// 绕开 SSR zustand getServerSnapshot 的坑（对齐 T2 DesignCostHistory 拆法）。
import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';

export interface ModelOption {
  id: string;
  label: string;
  available: boolean;
}

export interface ImageModelPickerViewProps {
  models: ModelOption[];
  value: string;
  onChange: (id: string) => void;
  /** 未配置 key 的 option 后缀文案（由容器经 i18n 注入，便于 SSR 测试）。 */
  unconfiguredLabel: string;
  ariaLabel?: string;
}

export const ImageModelPickerView: React.FC<ImageModelPickerViewProps> = ({
  models,
  value,
  onChange,
  unconfiguredLabel,
  ariaLabel,
}) => {
  return (
    <select
      data-testid="design-image-model"
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

/** 容器：挂载时拉取模型可用性（IPC），接 designStore 读写当前选中，i18n 注入未配置文案。 */
export const ImageModelPicker: React.FC = () => {
  const { t } = useI18n();
  const imageModel = useDesignStore((s) => s.imageModel);
  const setImageModel = useDesignStore((s) => s.setImageModel);
  const [models, setModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await window.domainAPI?.invoke<{ models: ModelOption[] }>(
        IPC_DOMAINS.WORKSPACE,
        'listVisualImageModels',
      );
      if (!cancelled && res?.success && res.data?.models) {
        setModels(
          res.data.models.map((m) => ({ id: m.id, label: m.label, available: m.available })),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ImageModelPickerView
      models={models}
      value={imageModel}
      onChange={setImageModel}
      unconfiguredLabel={t.design.imageModelUnconfigured}
      ariaLabel={t.design.imageModel}
    />
  );
};
