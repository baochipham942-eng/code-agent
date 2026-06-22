// ============================================================================
// ImageVideoSettings - 生成模型配置（图像 / 视频）
// 阶段 1：占位骨架；阶段 3 把 pricing.ts 的 DESIGN_* 常量抽成可配置项并打通设计画布。
// ============================================================================

import React from 'react';
import { ImagePlay } from 'lucide-react';
import { SettingsPage } from '../SettingsLayout';

export function ImageVideoSettings() {
  return (
    <SettingsPage
      title="生成模型"
      description="为图像生成 / 图像编辑 / 文生视频 / 图生视频分别选择模型。"
    >
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center">
        <ImagePlay className="h-8 w-8 text-zinc-600" />
        <div className="text-sm font-medium text-zinc-300">生成模型配置即将上线</div>
        <p className="max-w-md text-xs leading-relaxed text-zinc-500">
          图像与视频生成当前使用内置默认模型。可配置化（图像生成 / 图像编辑 / 文生视频 / 图生视频各自选模型）正在接入，届时设计画布将读取这里的配置。
        </p>
      </div>
    </SettingsPage>
  );
}
