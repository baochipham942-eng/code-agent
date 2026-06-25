// 自由画布导入按钮组（设计 Composer 内，仅图像产物模式显示）：
// 「添加图片」→ 普通画布素材节点（可直接圈选重绘）；
// 「添加参考图」→ role=reference 节点（生成时作为视觉参考喂模型，画布上 sky 徽章标识）。
// 两者也都支持画布上直接粘贴/拖拽（粘贴/拖拽走产物语义）。
import React, { useRef } from 'react';
import { ImagePlus, Images } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useDesignCanvasImport } from './useDesignCanvasImport';

export const DesignImportButtons: React.FC<{ generating: boolean }> = ({ generating }) => {
  const { t } = useI18n();
  const { importFiles } = useDesignCanvasImport();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      {/* ds-allow:start 导入按钮用透明描边自定义样式（Button secondary 是实色 zinc-600，会回归） */}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={generating}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] px-3 py-2 text-sm text-zinc-300 transition-colors hover:text-zinc-100 disabled:opacity-50"
      >
        <ImagePlus className="h-4 w-4" />
        {t.design.importImage}
      </button>
      {/* ds-allow:end */}
      <input
        ref={fileInputRef}
        data-testid="design-import-image-input"
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void importFiles(files);
          e.target.value = '';
        }}
      />
      <p className="text-[11px] leading-snug text-zinc-500">{t.design.importHint}</p>
      {/* 添加参考图：落 role=reference 节点，生成时作为视觉参考发给模型 */}
      {/* ds-allow:start 参考图按钮用 sky 描边自定义样式，与「参考」徽章视觉语言一致 */}
      <button
        type="button"
        onClick={() => referenceInputRef.current?.click()}
        disabled={generating}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-sky-400/30 px-3 py-2 text-sm text-sky-200 transition-colors hover:text-sky-100 disabled:opacity-50"
      >
        <Images className="h-4 w-4" />
        {t.design.addReference}
      </button>
      {/* ds-allow:end */}
      <input
        ref={referenceInputRef}
        data-testid="design-import-reference-input"
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void importFiles(files, { role: 'reference' });
          e.target.value = '';
        }}
      />
      <p className="text-[11px] leading-snug text-sky-400/70">{t.design.referenceHint}</p>
    </>
  );
};
