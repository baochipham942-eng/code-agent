// 选中图后的局部重绘面板（从 DesignCanvas 抽出，纯展示，无逻辑改动）。
// 仅图节点显示（视频/参考图不显示图像编辑工具）；回调由父组件预绑 selectedImageNode。
// 文案走 t.design.*，不硬编码。
import React from 'react';
import { SquareDashedMousePointer, X, Sparkles, Loader2, Download, Film, FileDown, Pencil } from 'lucide-react';
import type { Translations } from '../../i18n';
import { DesignImageEditOps } from './DesignImageEditOps';
import { AnnotModelSelect } from './DesignCanvasOverlays';
import { type AnnotTool } from './AnnotationLayer';
import type { ExpandDirection } from './useDesignCanvasGeneration';
import { estimateImageCostCny, formatCny } from '@shared/media/imageCost';

interface DesignImageEditPanelProps {
  t: Translations;
  generating: boolean;
  // 圈选局部重绘
  annotating: boolean;
  setAnnotating: React.Dispatch<React.SetStateAction<boolean>>;
  annotationCount: number;
  onClearAnnotations: () => void;
  instruction: string;
  setInstruction: (v: string) => void;
  onRepaint: () => void;
  // 导出 / 图生视频
  onExportImage: () => void;
  onGenerateVideo: () => void;
  onExportPdf: () => void;
  // T3 扩图 / 去水印
  expandDirection: ExpandDirection;
  expandRatio: number;
  onExpandDirectionChange: (d: ExpandDirection) => void;
  onExpandRatioChange: (r: number) => void;
  onExpand: () => void;
  onRemoveWatermark: () => void;
  // B4 标注重绘
  annotMode: boolean;
  setAnnotMode: (v: boolean) => void;
  annotTool: AnnotTool;
  setAnnotTool: (tool: AnnotTool) => void;
  effectiveAnnotModel: string;
  setAnnotModel: (id: string) => void;
  annotInstruction: string;
  setAnnotInstruction: (v: string) => void;
  annotShapeCount: number;
  onAnnotRedraw: () => void;
}

export function DesignImageEditPanel(props: DesignImageEditPanelProps): React.ReactElement {
  const {
    t,
    generating,
    annotating,
    setAnnotating,
    annotationCount,
    onClearAnnotations,
    instruction,
    setInstruction,
    onRepaint,
    onExportImage,
    onGenerateVideo,
    onExportPdf,
    expandDirection,
    expandRatio,
    onExpandDirectionChange,
    onExpandRatioChange,
    onExpand,
    onRemoveWatermark,
    annotMode,
    setAnnotMode,
    annotTool,
    setAnnotTool,
    effectiveAnnotModel,
    setAnnotModel,
    annotInstruction,
    setAnnotInstruction,
    annotShapeCount,
    onAnnotRedraw,
  } = props;
  return (
    <div className="absolute left-4 top-4 flex w-72 flex-col gap-2 rounded-xl border border-white/[0.1] bg-zinc-900/90 p-3 shadow-xl backdrop-blur">
      <div className="flex items-center justify-between">
        {/* ds-allow:start 圈选开关用 toggle 态自定义填充（active=bg-red-500/20，idle=bg-white/[0.06]，非 Button variant）+ 清除标注用裸文字按钮 */}
        <button
          type="button"
          onClick={() => setAnnotating((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
            annotating ? 'bg-red-500/20 text-red-200' : 'bg-white/[0.06] text-zinc-300 hover:text-zinc-100'
          }`}
        >
          <SquareDashedMousePointer className="h-3.5 w-3.5" />
          {annotating ? t.design.annotateStop : t.design.annotateStart}
        </button>
        {annotationCount > 0 && (
          <button
            type="button"
            onClick={onClearAnnotations}
            className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
          >
            <X className="h-3 w-3" />
            {t.design.clearAnnotations}（{annotationCount}）
          </button>
        )}
        {/* ds-allow:end */}
      </div>
      {annotating ? (
        <p className="text-[11px] leading-snug text-amber-300/80">{t.design.annotateHint}</p>
      ) : (
        annotationCount === 0 && (
          <p className="text-[11px] leading-snug text-zinc-500">{t.design.annotateGuide}</p>
        )
      )}
      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder={t.design.editInstructionPlaceholder}
        rows={3}
        className="resize-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
      />
      {/* ds-allow:start 局部重绘 CTA 用设计区品牌色 bg-fuchsia-500/90（Button primary 蓝渐变会丢视觉语言）+ 导出图片/图生视频用透明描边自定义样式（Button secondary 实色会回归） */}
      <button
        type="button"
        onClick={onRepaint}
        disabled={generating || annotationCount === 0 || !instruction.trim()}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
      >
        {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {generating ? t.design.editingRegion : t.design.editRegionBtn}
      </button>
      <button
        type="button"
        onClick={onExportImage}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:text-zinc-100"
      >
        <Download className="h-3.5 w-3.5" />
        {t.design.exportImage}
      </button>
      {/* P2 图生视频：以选中图为底图，生成前 confirm 预估 ¥（走 generateVideo i2v 路径）。 */}
      <button
        type="button"
        onClick={onGenerateVideo}
        disabled={generating}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:text-zinc-100 disabled:opacity-50"
      >
        <Film className="h-3.5 w-3.5" />
        {t.design.generateVideoFromImage}
      </button>
      {/* ds-allow:end */}
      {/* ds-allow:start 画布节点操作栏沿用旧裸 button 样式，与同栏导出图片按钮一致；design-mode 整体 W3 收口时统一迁 primitive */}
      <button
        type="button"
        onClick={onExportPdf}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:text-zinc-100"
      >
        <FileDown className="h-3.5 w-3.5" />
        {t.design.exportImagePdf}
      </button>
      {/* ds-allow:end */}

      {/* T3：wanx 扩图（方向+比例）+ 去水印，各落新 variant 挂 spine */}
      <DesignImageEditOps
        t={t}
        direction={expandDirection}
        ratio={expandRatio}
        generating={generating}
        onDirectionChange={onExpandDirectionChange}
        onRatioChange={onExpandRatioChange}
        onExpand={onExpand}
        onRemoveWatermark={onRemoveWatermark}
      />

      {/* B4：标注重绘（自由画标注 + 指令 + cap 模型 → editImageByAnnotation → 新 variant 挂 spine） */}
      <div className="mt-1 flex flex-col gap-2 border-t border-white/[0.08] pt-2">
        {/* ds-allow:start 标注重绘开关用 toggle 态自定义填充（active=bg-fuchsia-500/20，idle=bg-white/[0.06]，非 Button variant） */}
        <button
          type="button"
          onClick={() => setAnnotMode(!annotMode)}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
            annotMode ? 'bg-fuchsia-500/20 text-fuchsia-200' : 'bg-white/[0.06] text-zinc-300 hover:text-zinc-100'
          }`}
        >
          <Pencil className="h-3.5 w-3.5" />
          {t.design.annotMode}
        </button>
        {/* ds-allow:end */}
        {annotMode && (
          <>
            {/* 工具选择：自由笔 / 箭头 / 矩形 / 文字 */}
            <div className="flex gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
              {/* ds-allow:start 标注工具分段控件（active 用自定义 bg-white/[0.10]，非 Button variant） */}
              {([
                ['pen', t.design.annotToolPen],
                ['arrow', t.design.annotToolArrow],
                ['rect', t.design.annotToolRect],
                ['text', t.design.annotToolText],
              ] as Array<[AnnotTool, string]>).map(([tool, label]) => (
                <button
                  key={tool}
                  type="button"
                  onClick={() => setAnnotTool(tool)}
                  className={`flex-1 rounded-md px-1.5 py-1 text-[11px] transition-colors ${
                    annotTool === tool ? 'bg-white/[0.10] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {label}
                </button>
              ))}
              {/* ds-allow:end */}
            </div>
            {/* 重绘模型（cap 过滤；瞬时 annotModel，与全局 imageModel 解耦） */}
            <AnnotModelSelect value={effectiveAnnotModel} onChange={setAnnotModel} />
            {/* 重绘指令（带可见 label） */}
            <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
              <span>{t.design.annotInstruction}</span>
              <textarea
                value={annotInstruction}
                onChange={(e) => setAnnotInstruction(e.target.value)}
                placeholder={t.design.annotInstructionPlaceholder}
                rows={2}
                className="resize-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
              />
            </label>
            {/* 成本预估 */}
            <div className="text-[11px] text-zinc-500">
              {t.design.costEstimateLabel}{' '}
              <span className="font-mono text-emerald-300">{formatCny(estimateImageCostCny(effectiveAnnotModel))}</span>
            </div>
            {/* ds-allow:start 标注重绘 CTA 用设计区品牌色 bg-fuchsia-500/90（Button primary 蓝渐变会丢视觉语言） */}
            <button
              type="button"
              onClick={onAnnotRedraw}
              disabled={generating || annotShapeCount === 0 || !annotInstruction.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
            >
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {t.design.annotRedraw}
            </button>
            {/* ds-allow:end */}
          </>
        )}
      </div>
    </div>
  );
}
