// 设计画布图像操作面板（T3）：扩图（方向+比例）+ 去水印。
// 纯展示组件（无 konva），便于 SSR 截图 dogfood 与单测。文案走 t.design.*，不硬编码。
import React from 'react';
import { Maximize2, Eraser, Loader2 } from 'lucide-react';
import type { Translations } from '../../i18n';
import type { ExpandDirection } from './useDesignCanvasGeneration';

interface DesignImageEditOpsProps {
  t: Translations;
  direction: ExpandDirection;
  ratio: number;
  generating: boolean;
  onDirectionChange: (d: ExpandDirection) => void;
  onRatioChange: (r: number) => void;
  onExpand: () => void;
  onRemoveWatermark: () => void;
}

const DIRECTIONS: ReadonlyArray<readonly [ExpandDirection, keyof Translations['design']]> = [
  ['up', 'expandDirUp'],
  ['down', 'expandDirDown'],
  ['left', 'expandDirLeft'],
  ['right', 'expandDirRight'],
  ['all', 'expandDirAll'],
];

export function DesignImageEditOps(props: DesignImageEditOpsProps): React.ReactElement {
  const { t, direction, ratio, generating, onDirectionChange, onRatioChange, onExpand, onRemoveWatermark } = props;
  return (
    <div className="mt-1 flex flex-col gap-1.5 border-t border-white/[0.08] pt-2" data-testid="design-image-edit-ops">
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
        <Maximize2 className="h-3 w-3" />
        {t.design.expandTitle}
      </div>
      <div className="grid grid-cols-5 gap-1" data-testid="design-expand-directions">
        {/* ds-allow:start 五段方向分段控件（active 用自定义 bg-fuchsia-500/30，非 Button variant） */}
        {DIRECTIONS.map(([key, labelKey]) => (
          <button
            key={key}
            type="button"
            data-testid={`design-expand-dir-${key}`}
            onClick={() => onDirectionChange(key)}
            className={`rounded-md px-1 py-1 text-[11px] transition-colors ${
              direction === key
                ? 'bg-fuchsia-500/30 text-fuchsia-100'
                : 'bg-white/[0.06] text-zinc-300 hover:text-zinc-100'
            }`}
          >
            {t.design[labelKey] as string}
          </button>
        ))}
        {/* ds-allow:end */}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={1}
          max={2}
          step={0.1}
          value={ratio}
          data-testid="design-expand-ratio"
          onChange={(e) => onRatioChange(Number(e.target.value))}
          className="h-1 flex-1 accent-fuchsia-500"
        />
        <span className="w-10 text-right text-[11px] tabular-nums text-zinc-400">{ratio.toFixed(1)}×</span>
      </div>
      {/* ds-allow:start 扩图/去水印操作按钮用自定义半透明填充 bg-white/[0.06]（Button secondary 是实色 zinc-600，className 覆盖 bg 在 Tailwind 下不可靠会回归） */}
      <button
        type="button"
        data-testid="design-expand-btn"
        onClick={onExpand}
        disabled={generating}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-white/[0.1] disabled:opacity-50"
      >
        {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Maximize2 className="h-3.5 w-3.5" />}
        {t.design.expandBtn}
      </button>
      <button
        type="button"
        data-testid="design-remove-watermark-btn"
        onClick={onRemoveWatermark}
        disabled={generating}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-white/[0.1] disabled:opacity-50"
      >
        {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eraser className="h-3.5 w-3.5" />}
        {t.design.removeWatermarkBtn}
      </button>
      {/* ds-allow:end */}
    </div>
  );
}
