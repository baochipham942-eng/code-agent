// 图像动词条（2026-07-31 顶栏语义反转）：选中单个图节点时替换 DiagramToolbar 占顶部黄金位。
// 高频动词平铺（批注重绘/局部重绘/调整大小/扩图），低频动作收「更多 ⋯」；需要输入框的动作
// （局部重绘指令/标注重绘指令）用条下小浮层承载，不再占画布左上角的 288px 浮层。
// 不新造能力：每个动词都接 DesignCanvas 预绑 selectedImageNode 的现有回调。文案走 t.design.*。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Download,
  Eraser,
  FileDown,
  Film,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Pencil,
  Scaling,
  Sparkles,
  SquareDashedMousePointer,
  X,
} from 'lucide-react';
import type { Translations } from '../../i18n';
import { DesignImageEditOps } from './DesignImageEditOps';
import { AnnotModelSelect } from './DesignCanvasOverlays';
import { type AnnotTool } from './AnnotationLayer';
import type { ExpandDirection } from './useDesignCanvasGeneration';
import {
  computeResizeExpandPlan,
  RESIZE_RATIO_PRESETS,
  type ExpandStep,
  type ResizeRatioPresetId,
} from './designCanvasResizeRatio';
import { estimateImageCostCny, formatCny } from '@shared/media/imageCost';
import { DESIGN_IMAGE_MODELS } from '@shared/constants/pricing';

type MenuId = 'annotate' | 'repaint' | 'resize' | 'expand' | 'more' | null;

interface DesignImageToolbarProps {
  t: Translations;
  generating: boolean;
  /** 原图真实像素宽/高（selectedImageNode.width/height，落节点时量自结果图）。 */
  imageWidth: number;
  imageHeight: number;
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
  // 调整大小：五档比例预设 → expand 步骤计划（DesignCanvas 顺序执行）
  onResizePreset: (steps: ExpandStep[]) => void;
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

// 五档预设的比例小方块尺寸（照对齐稿：左边能表意的比例小方块）。
const PRESET_THUMBS: Record<ResizeRatioPresetId, { w: number; h: number }> = {
  '1:1': { w: 18, h: 18 },
  '3:4': { w: 15, h: 20 },
  '9:16': { w: 12, h: 21 },
  '4:3': { w: 20, h: 15 },
  '16:9': { w: 24, h: 14 },
};

const PRESET_NAME_KEYS: Record<ResizeRatioPresetId, keyof Translations['design']> = {
  '1:1': 'resizePresetSquare',
  '3:4': 'resizePresetPortrait',
  '9:16': 'resizePresetStory',
  '4:3': 'resizePresetLandscape',
  '16:9': 'resizePresetWide',
};

const MENU_CLASS =
  'absolute left-1/2 top-full z-20 mt-2 w-64 -translate-x-1/2 rounded-xl border border-white/[0.1] bg-zinc-900/95 p-2 shadow-xl backdrop-blur';

export function DesignImageToolbar(props: DesignImageToolbarProps): React.ReactElement {
  const {
    t,
    generating,
    imageWidth,
    imageHeight,
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
    onResizePreset,
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

  const [openMenu, setOpenMenu] = useState<MenuId>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 外点关菜单（document 级监听，不铺 fixed inset-0 背板，避免 handrolled-modal 门）。
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  const toggle = (m: Exclude<MenuId, null>): void => {
    setOpenMenu((cur) => (cur === m ? null : m));
  };

  // 批注重绘按钮 = annotMode 开关：进模式同时弹出指令浮层，再点退模式收浮层。
  const onAnnotateClick = (): void => {
    const next = !annotMode;
    setAnnotMode(next);
    setOpenMenu(next ? 'annotate' : null);
  };

  // 五档比例预设：由原图真实宽高 + 目标比例算 expand 步骤计划；不可行档位禁用并展示原因。
  const resizePresets = useMemo(
    () =>
      (Object.entries(RESIZE_RATIO_PRESETS) as Array<[ResizeRatioPresetId, number]>).map(
        ([id, ratio]) => ({ id, ratio, plan: computeResizeExpandPlan(imageWidth, imageHeight, ratio) }),
      ),
    [imageWidth, imageHeight],
  );

  // 成本预估按实际步数算（两步对称扩展 = 两次付费扩图），不许只算一次的钱。
  const resizeCostHint = (steps: ExpandStep[]): string =>
    t.design.resizeCostHint
      .replace('{cost}', formatCny(steps.length * estimateImageCostCny(DESIGN_IMAGE_MODELS.edit)))
      .replace('{steps}', String(steps.length));

  const runAndClose = (fn: () => void): void => {
    setOpenMenu(null);
    fn();
  };

  return (
    <div
      ref={rootRef}
      data-testid="design-image-toolbar"
      // 与 DiagramToolbar 同槽位同质感（顶部黄金位），窄栏允许换行（同 D8 窄栏适配）。
      className="absolute left-1/2 top-4 z-10 max-w-[calc(100%-1rem)] -translate-x-1/2"
    >
      <div className="relative flex flex-wrap items-center justify-center gap-1 rounded-xl border border-white/[0.1] bg-zinc-900/90 px-2 py-1.5 shadow-xl backdrop-blur">
        {/* ds-allow:start 动词条按钮为图标+文字组合 toggle/下拉触发器（active=bg-fuchsia-500/20 品牌色 toggle 态，非 Button variant），与同画布的 DiagramToolbar 裸按钮一致，design-mode W3 收口时统一迁 primitive */}
        <button
          type="button"
          data-testid="design-toolbar-annotate"
          aria-pressed={annotMode}
          onClick={onAnnotateClick}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
            annotMode ? 'bg-fuchsia-500/20 text-fuchsia-200' : 'text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100'
          }`}
        >
          <Pencil className="h-3.5 w-3.5" />
          {t.design.annotMode}
        </button>
        <button
          type="button"
          data-testid="design-toolbar-repaint"
          aria-expanded={openMenu === 'repaint'}
          onClick={() => toggle('repaint')}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
            openMenu === 'repaint' || annotating
              ? 'bg-fuchsia-500/20 text-fuchsia-200'
              : 'text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100'
          }`}
        >
          <SquareDashedMousePointer className="h-3.5 w-3.5" />
          {t.design.editRegionBtn}
        </button>
        <button
          type="button"
          data-testid="design-toolbar-resize"
          aria-expanded={openMenu === 'resize'}
          onClick={() => toggle('resize')}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
            openMenu === 'resize'
              ? 'bg-fuchsia-500/20 text-fuchsia-200'
              : 'text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100'
          }`}
        >
          <Scaling className="h-3.5 w-3.5" />
          {t.design.imageToolbarResize}
          <ChevronDown className="h-3 w-3 text-zinc-500" />
        </button>
        <button
          type="button"
          data-testid="design-toolbar-expand"
          aria-expanded={openMenu === 'expand'}
          onClick={() => toggle('expand')}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
            openMenu === 'expand'
              ? 'bg-fuchsia-500/20 text-fuchsia-200'
              : 'text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100'
          }`}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          {t.design.expandTitle}
          <ChevronDown className="h-3 w-3 text-zinc-500" />
        </button>
        <button
          type="button"
          data-testid="design-toolbar-more"
          aria-expanded={openMenu === 'more'}
          onClick={() => toggle('more')}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
            openMenu === 'more'
              ? 'bg-fuchsia-500/20 text-fuchsia-200'
              : 'text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100'
          }`}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
          {t.design.imageToolbarMore}
        </button>
        {/* ds-allow:end */}
      </div>

      {/* 批注重绘浮层：工具选择 + 指令 + 成本 + CTA（模型选择收在「更多」）。 */}
      {openMenu === 'annotate' && (
        <div data-testid="design-annotate-popover" className={MENU_CLASS}>
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
          <label className="mt-2 flex flex-col gap-1 text-[11px] text-zinc-500">
            <span>{t.design.annotInstruction}</span>
            <textarea
              value={annotInstruction}
              onChange={(e) => setAnnotInstruction(e.target.value)}
              placeholder={t.design.annotInstructionPlaceholder}
              rows={2}
              className="resize-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
            />
          </label>
          <div className="mt-2 text-[11px] text-zinc-500">
            {t.design.costEstimateLabel}{' '}
            <span className="font-mono text-emerald-300">{formatCny(estimateImageCostCny(effectiveAnnotModel))}</span>
          </div>
          {/* ds-allow:start 标注重绘 CTA 用设计区品牌色 bg-fuchsia-500/90（Button primary 蓝渐变会丢视觉语言） */}
          <button
            type="button"
            data-testid="design-annot-redraw-btn"
            onClick={() => runAndClose(onAnnotRedraw)}
            disabled={generating || annotShapeCount === 0 || !annotInstruction.trim()}
            className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {t.design.annotRedraw}
          </button>
          {/* ds-allow:end */}
        </div>
      )}

      {/* 局部重绘浮层：圈选开关 + 引导 + 指令 + CTA（原 288px 浮层的圈选部分原样搬入）。 */}
      {openMenu === 'repaint' && (
        <div data-testid="design-repaint-popover" className={MENU_CLASS}>
          <div className="flex items-center justify-between">
            {/* ds-allow:start 圈选开关用 toggle 态自定义填充（active=bg-red-500/20，idle=bg-white/[0.06]，非 Button variant）+ 清除标注用裸文字按钮 */}
            <button
              type="button"
              data-testid="design-annotate-toggle"
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
            <p className="mt-2 text-[11px] leading-snug text-amber-300/80">{t.design.annotateHint}</p>
          ) : (
            annotationCount === 0 && (
              <p className="mt-2 text-[11px] leading-snug text-zinc-500">{t.design.annotateGuide}</p>
            )
          )}
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={t.design.editInstructionPlaceholder}
            rows={3}
            className="mt-2 w-full resize-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
          />
          {/* ds-allow:start 局部重绘 CTA 用设计区品牌色 bg-fuchsia-500/90（Button primary 蓝渐变会丢视觉语言） */}
          <button
            type="button"
            data-testid="design-repaint-btn"
            onClick={() => runAndClose(onRepaint)}
            disabled={generating || annotationCount === 0 || !instruction.trim()}
            className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {generating ? t.design.editingRegion : t.design.editRegionBtn}
          </button>
          {/* ds-allow:end */}
        </div>
      )}

      {/* 调整大小下拉：五档比例预设（比例小方块 + 人话名字 + 灰色比例数字）。
          不可行档位禁用并展示原因；可行档位展示按实际步数算的成本预估。 */}
      {openMenu === 'resize' && (
        <div data-testid="design-resize-menu" className={MENU_CLASS}>
          {/* ds-allow:start 比例预设菜单项为图标+双行文字复合行（含禁用原因/成本小灰字），非 Button variant 能表达 */}
          {resizePresets.map(({ id, plan }) => {
            const feasible = plan.feasible && plan.steps.length > 0;
            const thumb = PRESET_THUMBS[id];
            return (
              <button
                key={id}
                type="button"
                data-testid={`design-resize-preset-${id.replace(':', '-')}`}
                disabled={generating || !feasible}
                onClick={() => plan.feasible && runAndClose(() => onResizePreset(plan.steps))}
                className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors first:mt-0 hover:bg-white/[0.06] disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <span className="flex h-6 w-7 items-center justify-center">
                  <span
                    className="block rounded-sm border-[1.5px] border-zinc-400"
                    style={{ width: thumb.w, height: thumb.h }}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-xs text-zinc-200">{t.design[PRESET_NAME_KEYS[id]] as string}</span>
                  {!plan.feasible ? (
                    <span className="text-[10px] leading-snug text-zinc-500">{plan.reason}</span>
                  ) : plan.steps.length === 0 ? (
                    <span className="text-[10px] leading-snug text-zinc-500">{t.design.resizeAlreadyRatio}</span>
                  ) : (
                    <span className="font-mono text-[10px] leading-snug text-emerald-300/80">
                      {resizeCostHint(plan.steps)}
                    </span>
                  )}
                </span>
                <span className="ml-auto text-[11px] tabular-nums text-zinc-500">{id}</span>
              </button>
            );
          })}
          {/* ds-allow:end */}
        </div>
      )}

      {/* 扩图下拉：方向五选 + 倍率滑杆 + 扩展画布（去水印已收「更多」）。 */}
      {openMenu === 'expand' && (
        <div data-testid="design-expand-menu" className={MENU_CLASS}>
          <DesignImageEditOps
            t={t}
            direction={expandDirection}
            ratio={expandRatio}
            generating={generating}
            onDirectionChange={onExpandDirectionChange}
            onRatioChange={onExpandRatioChange}
            onExpand={() => runAndClose(onExpand)}
          />
        </div>
      )}

      {/* 更多 ⋯：原 288px 浮层里的低频动作，对照 DesignImageEditPanel 逐项收编，一个不少。 */}
      {openMenu === 'more' && (
        <div data-testid="design-more-menu" className={MENU_CLASS}>
          {/* ds-allow:start 更多菜单项为图标+文字菜单行（hover 态自定义，非 Button variant） */}
          <button
            type="button"
            data-testid="design-more-remove-watermark"
            onClick={() => runAndClose(onRemoveWatermark)}
            disabled={generating}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-50"
          >
            <Eraser className="h-3.5 w-3.5 text-zinc-500" />
            {t.design.removeWatermarkBtn}
          </button>
          <button
            type="button"
            data-testid="design-more-export-image"
            onClick={() => runAndClose(onExportImage)}
            className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
          >
            <Download className="h-3.5 w-3.5 text-zinc-500" />
            {t.design.exportImage}
          </button>
          <button
            type="button"
            data-testid="design-more-export-pdf"
            onClick={() => runAndClose(onExportPdf)}
            className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
          >
            <FileDown className="h-3.5 w-3.5 text-zinc-500" />
            {t.design.exportImagePdf}
          </button>
          <button
            type="button"
            data-testid="design-more-generate-video"
            onClick={() => runAndClose(onGenerateVideo)}
            disabled={generating}
            className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-50"
          >
            <Film className="h-3.5 w-3.5 text-zinc-500" />
            {t.design.generateVideoFromImage}
          </button>
          {/* ds-allow:end */}
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/[0.08] px-2 pt-2">
            <span className="text-[11px] text-zinc-400">{t.design.annotModelSelectLabel}</span>
            <AnnotModelSelect value={effectiveAnnotModel} onChange={setAnnotModel} />
          </div>
        </div>
      )}
    </div>
  );
}
