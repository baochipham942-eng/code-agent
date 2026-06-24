// 设计工作区（Kun 借鉴：设计 tab）。左侧 composer（历史 + 需求 + 设计上下文 + 产物
// 类型）+ 右侧预览。v1 把「交互原型」整条闭环打通；设计稿/信息图占位标「即将」。
// 所有面向用户的文案统一走 i18n（t.design.*），避免中英混排。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Palette,
  Sparkles,
  Loader2,
  AlertCircle,
  History,
  ChevronRight,
  Monitor,
  Tablet,
  Smartphone,
  Wand2,
  Send,
  MousePointerClick,
  X,
  ExternalLink,
  Download,
  FileDown,
  Maximize2,
  Minimize2,
  BadgeCheck,
  Pencil,
  Presentation,
} from 'lucide-react';
import { Button, IconButton } from '../primitives';
import { BrandManager } from './BrandManager';
import { FullScreenPage } from '../features/shared/FullScreenPage';
import { WorkspaceModeSwitch } from './WorkspaceModeSwitch';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';
import { useDesignGeneration } from './useDesignGeneration';
import { useDesignCanvasGeneration } from './useDesignCanvasGeneration';
import { DesignImportButtons } from './DesignImportButtons';
import { useDesignCanvasStore } from './designCanvasStore';
import { useRestoreCanvasFromDisk } from './useRestoreCanvasFromDisk';
import { DesignCanvas } from './DesignCanvas';
import { DesignSlidesPanel } from './DesignSlidesPanel';
import { SlideOutlineEditor } from './SlideOutlineEditor';
import { useDesignSlidesStore } from './designSlidesStore';
import {
  readRunHtml,
  readWorkspaceFile,
  writeWorkspaceFile,
  findRunHtml,
  listVersions,
  openInDefaultApp,
  saveHtmlToDownloads,
  exportPrototypePdf,
} from './designFiles';
import { DESIGN_ASPECT_RATIOS, designDeviceWidth, prototypeExportName, prototypePdfExportName } from './designTypes';
import type { DesignOutputType, DesignSurface, PrototypeSelection } from './designTypes';
import {
  injectSelectionScript,
  injectInlineEditScript,
  injectPreviewStyle,
  injectThemeOverride,
  parseProtoSelectMessage,
  parseProtoTextEditMessage,
  PROTO_PALETTES,
} from './designPreviewInject';
import { applyTextEdit } from './inlineTextEdit';
import { DESIGN_DEVICE_PRESETS, DESIGN_IMAGE_MODELS, type DesignDeviceId } from '@shared/constants';
import { estimateImageCostCny, formatCny } from '@shared/media/imageCost';
import { estimateVideoCostCny } from '@shared/media/videoCost';
import { videoModelById, clampVideoDuration } from '@shared/constants/visualModels';
import { DesignCostHistory } from './DesignCostHistory';
import { ImageModelPicker } from './ImageModelPicker';
import { VideoModelPicker } from './VideoModelPicker';
import { VariantCompareView } from './VariantCompareView';
import { loadProtoSpine } from './protoSpine';
import { activeVariants } from './variantSpine';
import { ViewingBanner } from './DesignVersionUI';
import { DesignProtoHistory, useProtoVersionActions } from './DesignProtoHistory';

// 品牌色输入框（<input type="color">）的默认值——这是数据值（用户填进 brandColor 的种子），不是 UI 样式。
const DEFAULT_BRAND_COLOR = '#3b82f6'; // ds-allow:viz 品牌色输入框默认值（数据非 UI 样式）

/** 图像类产物（走 konva 画布）：设计稿 / 信息图。交互原型仍走 HTML iframe。 */
function isImageOutput(t: DesignOutputType): boolean {
  return t === 'mockup' || t === 'infographic';
}

/** 视频产物（走 konva 画布 + generateVideo 派发）。 */
function isVideoOutput(t: DesignOutputType): boolean {
  return t === 'video';
}

/** 演示稿产物（厚版，二期接入；一期为占位）。 */
function isSlidesOutput(t: DesignOutputType): boolean {
  return t === 'slides';
}

/** 落 konva 画布的产物：设计稿 / 信息图 / 视频。 */
function isCanvasOutput(t: DesignOutputType): boolean {
  return isImageOutput(t) || isVideoOutput(t);
}

/** 交付媒介（UI 聚合层）：网页 / 图 / 演示稿 / 视频。内部仍用 DesignOutputType。 */
export type DesignMedia = 'web' | 'image' | 'slides' | 'video';

/** DesignOutputType → 媒介。mockup/infographic 同属「图」。 */
export function outputToMedia(t: DesignOutputType): DesignMedia {
  if (t === 'prototype') return 'web';
  if (isImageOutput(t)) return 'image';
  if (t === 'slides') return 'slides';
  return 'video';
}

/** 媒介 → DesignOutputType。「图」保留当前子类（默认设计稿）。 */
export function mediaToOutput(m: DesignMedia, current: DesignOutputType): DesignOutputType {
  switch (m) {
    case 'web':
      return 'prototype';
    case 'image':
      return isImageOutput(current) ? current : 'mockup';
    case 'slides':
      return 'slides';
    case 'video':
      return 'video';
  }
}

/** 加载某次历史生成的产物 + 版本列表到预览。 */
async function loadRun(runDir: string): Promise<void> {
  useDesignStore.getState().selectRun(runDir);
  const html = await readRunHtml(runDir);
  // 期间未被其它操作取代才写入。
  if (html && useDesignStore.getState().previewPath === runDir) {
    useDesignStore.getState().setPreviewHtml(html);
  }
  const versions = await listVersions(runDir);
  if (useDesignStore.getState().previewPath === runDir) {
    useDesignStore.getState().setVersions(versions);
    // 载入 variant spine（版本的 pin/discard），与磁盘版本对账。
    const spine = await loadProtoSpine(runDir, versions);
    if (useDesignStore.getState().previewPath === runDir) {
      useDesignStore.getState().setSpine(spine);
    }
  }
}

const HistorySection: React.FC = () => {
  const { t } = useI18n();
  const history = useDesignStore((s) => s.history);
  const selectedRunDir = useDesignStore((s) => s.selectedRunDir);
  const [open, setOpen] = useState(false);

  if (history.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {/* ds-allow:start 折叠区披露开关（无填充的树形 disclosure 行，非 Button variant）+ 历史项整宽自定义列表行 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <History className="h-3.5 w-3.5" />
        <span>
          {t.design.historyTitle}（{history.length}）
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 pl-1">
          {history.map((run) => (
            <button
              key={run.runDir}
              type="button"
              onClick={() => void loadRun(run.runDir)}
              title={run.requirement}
              className={`truncate rounded-md px-2 py-1 text-left text-xs transition-colors ${
                selectedRunDir === run.runDir
                  ? 'bg-white/[0.08] text-zinc-100'
                  : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
              }`}
            >
              {run.requirement || run.runDir.split('/').pop()}
            </button>
          ))}
          {/* ds-allow:end */}
        </div>
      )}
    </div>
  );
};

const Composer: React.FC = () => {
  const { t } = useI18n();
  const s = useDesignStore();
  const { generate: generatePrototype } = useDesignGeneration();
  const { generate: generateCanvas, generateVideo } = useDesignCanvasGeneration();
  const canvasGenerating = useDesignCanvasStore((c) => c.generating);
  const canvasError = useDesignCanvasStore((c) => c.error);

  // 主控件按「交付媒介」分 4 类；「图」激活时出二级（设计稿 / 信息图）。
  const mediaTabs: Array<{ media: DesignMedia; label: string }> = [
    { media: 'web', label: t.design.outputWeb },
    { media: 'image', label: t.design.outputImage },
    { media: 'slides', label: t.design.outputSlides },
    { media: 'video', label: t.design.outputVideo },
  ];
  const imageSubTabs: Array<{ type: DesignOutputType; label: string }> = [
    { type: 'mockup', label: t.design.outputMockup },
    { type: 'infographic', label: t.design.outputInfographic },
  ];
  const activeMedia = outputToMedia(s.outputType);
  const imageMode = isImageOutput(s.outputType);
  const videoMode = isVideoOutput(s.outputType);
  const slidesMode = isSlidesOutput(s.outputType);
  // 视频与图像产物都落 konva 画布，共用 canvas store 的 generating/error。
  const canvasMode = imageMode || videoMode;
  // 交互原型（网页）模式：左侧统一历史面板渲染 proto 版本控件。
  const protoMode = !canvasMode && !slidesMode;
  const generating = canvasMode ? canvasGenerating : s.status === 'generating';
  const error = canvasMode ? canvasError : s.error;
  const onGenerate = videoMode ? () => generateVideo() : imageMode ? generateCanvas : generatePrototype;
  const surfaces: Array<{ value: DesignSurface; label: string }> = [
    { value: 'brand', label: t.design.surfaceBrand },
    { value: 'product', label: t.design.surfaceProduct },
  ];

  return (
    <div className="flex flex-col gap-5 w-80 shrink-0 border-r border-white/[0.06] p-4 overflow-y-auto">
      <HistorySection />

      {/* 产物媒介（4 类，按交付形态：网页 / 图 / 演示稿 / 视频） */}
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
          {/* ds-allow:start 媒介分段控件（active 用自定义 bg-white/[0.10]，非 Button variant） */}
          {mediaTabs.map(({ media, label }) => (
            <button
              key={media}
              type="button"
              onClick={() => s.setOutputType(mediaToOutput(media, s.outputType))}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                activeMedia === media
                  ? 'bg-white/[0.10] text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
          {/* ds-allow:end */}
        </div>
        {/* 「图」二级：设计稿 / 信息图（仅图媒介激活时出现） */}
        {activeMedia === 'image' && (
          <div className="flex gap-1.5 pl-0.5">
            {/* ds-allow:start 图二级单选 pill（选中态 fuchsia 描边，与出图尺寸 pill 同语言） */}
            {imageSubTabs.map(({ type, label }) => (
              <button
                key={type}
                type="button"
                onClick={() => s.setOutputType(type)}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  s.outputType === type
                    ? 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200'
                    : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
            {/* ds-allow:end */}
          </div>
        )}
      </div>

      {/* 需求 */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-zinc-400">{t.design.requirementLabel}</span>
        <textarea
          value={s.requirement}
          onChange={(e) => s.setRequirement(e.target.value)}
          placeholder={t.design.requirementPlaceholder}
          rows={5}
          className="resize-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
        />
      </label>

      {/* 品牌色 */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-zinc-400">{t.design.brandColorLabel}</span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={s.brandColor || DEFAULT_BRAND_COLOR}
            onChange={(e) => s.setBrandColor(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border border-white/[0.08] bg-transparent"
          />
          <input
            type="text"
            value={s.brandColor}
            onChange={(e) => s.setBrandColor(e.target.value)}
            placeholder={t.design.brandColorPlaceholder}
            className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
          />
        </div>
      </label>

      {/* 语气 */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-zinc-400">{t.design.toneLabel}</span>
        <div className="flex flex-wrap gap-1.5">
          {/* ds-allow:start 语气多选 pill（圆角全 + 选中态自定义 fuchsia 描边/底，非 Button variant） */}
          {t.design.tones.map((tone) => (
            <button
              key={tone}
              type="button"
              onClick={() => s.toggleTone(tone)}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                s.tone.includes(tone)
                  ? 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200'
                  : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {tone}
            </button>
          ))}
          {/* ds-allow:end */}
        </div>
      </div>

      {/* Surface */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-zinc-400">{t.design.surfaceLabel}</span>
        <div className="flex gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
          {/* ds-allow:start surface 分段控件（active 用自定义 bg-white/[0.10]，非 Button variant） */}
          {surfaces.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => s.setSurface(value)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                s.surface === value
                  ? 'bg-white/[0.10] text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
          {/* ds-allow:end */}
        </div>
      </div>

      {/* 生图模型（仅图像产物）：仅选择已配置模型，未配置 key 的灰显。
          自定义端点的「配置/管理」归设置页「生成模型」tab（IA：设计页只选不配）。 */}
      {imageMode && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-zinc-400">{t.design.imageModel}</span>
          <ImageModelPicker />
        </div>
      )}

      {/* 出图尺寸（仅图像产物） */}
      {imageMode && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-zinc-400">{t.design.aspectRatioLabel}</span>
          <div className="flex flex-wrap gap-1.5">
            {/* ds-allow:start 出图尺寸单选 pill（选中态自定义 fuchsia 描边/底，非 Button variant） */}
            {DESIGN_ASPECT_RATIOS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => s.setAspectRatio(r)}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  s.aspectRatio === r
                    ? 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200'
                    : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {r}
              </button>
            ))}
            {/* ds-allow:end */}
          </div>
        </div>
      )}

      {/* 出图前成本预估（T2 成本透明，仅图像产物走付费图像调用） */}
      {imageMode && (
        <div className="-mb-2 flex items-center justify-between rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-1.5 text-[11px]">
          <span className="text-zinc-400">
            {t.design.costEstimateLabel}{' '}
            <span className="font-mono text-emerald-300">
              {formatCny(estimateImageCostCny(DESIGN_IMAGE_MODELS.generate))}
            </span>
          </span>
          <span className="text-zinc-500">{t.design.costHint}</span>
        </div>
      )}

      {/* 视频产物：模式(t2v/i2v) + 视频模型 + 时长 + 成本预估（视频按秒，比图贵一量级） */}
      {videoMode && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-zinc-400">{t.design.videoModeLabel}</span>
            <div className="flex gap-1.5">
              {/* ds-allow:start 视频模式分段控件（active 用自定义 bg-white/[0.10]，非 Button variant） */}
              {(['t2v', 'i2v'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => s.setVideoMode(m)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                    s.videoMode === m ? 'bg-white/[0.10] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {m === 't2v' ? t.design.videoModeT2v : t.design.videoModeI2v}
                </button>
              ))}
              {/* ds-allow:end */}
            </div>
            {s.videoMode === 'i2v' && (
              <span className="text-[11px] leading-snug text-zinc-500">{t.design.videoI2vHint}</span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-zinc-400">{t.design.videoModel}</span>
            <VideoModelPicker />
          </div>

          {(() => {
            const vm = videoModelById(s.videoModel);
            const adjustable = vm ? vm.minDurationSec < vm.maxDurationSec : false;
            const dur = vm ? clampVideoDuration(vm, s.videoDurationSec) : s.videoDurationSec;
            return (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-zinc-400">
                  {t.design.videoDurationLabel}：<span className="font-mono text-zinc-300">{dur}s</span>
                </span>
                {adjustable && vm && (
                  <input
                    type="range"
                    min={vm.minDurationSec}
                    max={vm.maxDurationSec}
                    step={1}
                    value={dur}
                    onChange={(e) => s.setVideoDurationSec(Number(e.target.value))}
                    aria-label={t.design.videoDurationLabel}
                  />
                )}
              </div>
            );
          })()}

          {(() => {
            const vm = videoModelById(s.videoModel);
            const dur = vm ? clampVideoDuration(vm, s.videoDurationSec) : s.videoDurationSec;
            return (
              <div className="-mb-2 flex items-center justify-between rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-1.5 text-[11px]">
                <span className="text-zinc-300">
                  {t.design.costEstimateLabel}{' '}
                  <span className="font-mono text-amber-300">{formatCny(estimateVideoCostCny(s.videoModel, dur))}</span>
                </span>
                <span className="text-zinc-500">{t.design.videoCostHint}</span>
              </div>
            );
          })()}
        </div>
      )}

      {/* 演示稿（厚版 MVP）：页数 + 生成 → 真排版 PPTX 导出到下载 */}
      {slidesMode ? (
        <div className="flex flex-col gap-2">
          <div className="rounded-lg border border-fuchsia-400/20 bg-fuchsia-400/[0.06] px-3 py-2 text-[11px] leading-snug text-zinc-400">
            {t.design.slidesComingSoon}
          </div>
          <DesignSlidesPanel />
        </div>
      ) : (
        <>
          {/* ds-allow:start 主生成 CTA 用设计区品牌色 bg-fuchsia-500/90（Button primary 是蓝色渐变，会丢设计区视觉语言） */}
          <button
            type="button"
            onClick={() => void onGenerate()}
            disabled={generating}
            className="mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {generating ? t.design.generating : t.design.generate}
          </button>
          {/* ds-allow:end */}
        </>
      )}

      {/* 自由画布：导入自有图片 + 添加参考图（也支持画布上粘贴/拖拽） */}
      {imageMode && <DesignImportButtons generating={generating} />}

      {/* T2 成本透明 + undo/redo 历史（仅图像产物，挂 variant spine） */}
      {imageMode && <DesignCostHistory />}

      {/* 交互原型统一历史：版本看/对比/定稿（P2 从预览工具栏并入左侧 composer） */}
      {protoMode && <DesignProtoHistory />}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

const DEVICE_ICONS: Record<DesignDeviceId, React.ReactNode> = {
  desktop: <Monitor className="h-3.5 w-3.5" />,
  tablet: <Tablet className="h-3.5 w-3.5" />,
  mobile: <Smartphone className="h-3.5 w-3.5" />,
};

const DeviceSwitch: React.FC<{ device: DesignDeviceId; onChange: (d: DesignDeviceId) => void }> = ({
  device,
  onChange,
}) => {
  const { t } = useI18n();
  const labels: Record<DesignDeviceId, string> = {
    desktop: t.design.deviceDesktop,
    tablet: t.design.deviceTablet,
    mobile: t.design.deviceMobile,
  };
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
      {DESIGN_DEVICE_PRESETS.map(({ id }) => {
        const active = device === id;
        return (
          // ds-allow:start 设备切换分段控件段（active 用自定义 bg-white/[0.10]，非 Button variant）
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            title={labels[id]}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
              active ? 'bg-white/[0.10] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {DEVICE_ICONS[id]}
            <span>{labels[id]}</span>
          </button>
          // ds-allow:end
        );
      })}
    </div>
  );
};

/**
 * 配色切换（T6 Tweaks 换肤）：对预览 iframe 注入 hue-rotate 覆盖，零重生成实时试色板。
 * 仅作用于预览渲染——导出/快照用 previewHtml 原文，不含本注入样式。色板对任意原型都是
 * 「整轮色相旋转」，swatch 以品牌色 hue-rotate 后给个视觉提示，非绝对配色。
 */
const PaletteSwitch: React.FC<{ palette: string; onChange: (id: string) => void }> = ({
  palette,
  onChange,
}) => {
  const { t } = useI18n();
  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-1.5 py-1"
      title={t.design.paletteLabel}
    >
      <Palette className="h-3.5 w-3.5 text-zinc-400" />
      {PROTO_PALETTES.map(({ id, deg }) => {
        const active = palette === id;
        const label = t.design.palettes[id as keyof typeof t.design.palettes] ?? id;
        return (
          // ds-allow:start 配色 swatch 圆点（h-4 w-4 纯色块 + hue-rotate style，非图标/文字按钮，IconButton 不适用）
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            title={label}
            className={`h-4 w-4 rounded-full border transition-transform ${
              active ? 'border-white scale-110' : 'border-white/20 hover:scale-105'
            }`}
            style={{ background: '#d946ef', filter: `hue-rotate(${deg}deg)` }} // ds-allow:viz 色板 swatch 种子色，由 hue-rotate 旋出各档主题色
          />
          // ds-allow:end
        );
      })}
    </div>
  );
};

/**
 * 续编输入条：在当前预览的原型上继续局部修改（backlog #3）。
 * selection 由 PreviewPane 圈选传入（backlog #2）：有选中时附目标元素定位并显示 chip。
 */
const ContinueEditBar: React.FC<{
  selection: PrototypeSelection | null;
  onClearSelection: () => void;
}> = ({ selection, onClearSelection }) => {
  const { t } = useI18n();
  const { continueEdit } = useDesignGeneration();
  const generating = useDesignStore((s) => s.status === 'generating');
  const [text, setText] = useState('');

  const submit = async (): Promise<void> => {
    const v = text.trim();
    if (!v || generating) return;
    setText('');
    const sel = selection ?? undefined;
    onClearSelection();
    await continueEdit(v, sel);
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-white/[0.06] px-3 py-2">
      {selection && (
        <div className="flex items-center gap-1.5 self-start rounded-md border border-fuchsia-400/30 bg-fuchsia-400/10 px-2 py-0.5 text-[11px] text-fuchsia-200">
          <MousePointerClick className="h-3 w-3" />
          <span>{t.design.selectionTarget}</span>
          <span className="font-mono text-fuchsia-300">&lt;{selection.tag}&gt;</span>
          {selection.text && <span className="max-w-[160px] truncate text-zinc-300">{selection.text}</span>}
          {/* ds-allow:start chip 内清除按钮用自定义 fuchsia 文字色（与 chip 同色系，IconButton variant 文字色会冲突覆盖不可靠） */}
          <button type="button" onClick={onClearSelection} className="ml-0.5 text-fuchsia-300 hover:text-fuchsia-100">
            <X className="h-3 w-3" />
          </button>
          {/* ds-allow:end */}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Wand2 className="h-3.5 w-3.5 shrink-0 text-fuchsia-300" />
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t.design.continueEditPlaceholder}
          disabled={generating}
          className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none disabled:opacity-50"
        />
        {/* ds-allow:start 续编发送 CTA 用设计区品牌色 bg-fuchsia-500/90（Button primary 是蓝色渐变，会丢设计区视觉语言） */}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={generating || !text.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-fuchsia-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" />
          {t.design.continueEditSend}
        </button>
        {/* ds-allow:end */}
      </div>
    </div>
  );
};

// 演示稿预览：有大纲 → 逐页编辑器（预览 + 就地改字）；否则占位引导。
const SlidesPreview: React.FC = () => {
  const { t } = useI18n();
  const hasOutline = useDesignSlidesStore((s) => !!s.outline && s.outline.length > 0);
  if (hasOutline) return <SlideOutlineEditor />;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-zinc-500">
      <Presentation className="h-6 w-6 text-zinc-600" />
      <span>{t.design.slidesPreviewSoon}</span>
    </div>
  );
};

const PreviewPane: React.FC = () => {
  const { t } = useI18n();
  const outputType = useDesignStore((s) => s.outputType);
  const previewHtml = useDesignStore((s) => s.previewHtml);
  const status = useDesignStore((s) => s.status);
  const selectedRunDir = useDesignStore((s) => s.selectedRunDir);
  const viewingVersionPath = useDesignStore((s) => s.viewingVersionPath);
  const spine = useDesignStore((s) => s.spine);
  const [device, setDevice] = useState<DesignDeviceId>('desktop');
  const [palette, setPalette] = useState('original');
  const [selectMode, setSelectMode] = useState(false);
  // 就地文本编辑模式（CD-Parity §3）：点字直接改、免 AI、回写 canonical prototype.html。
  // 与圈选模式互斥（同一点击不可既圈选又编辑），切到任一态即关掉另一态。
  const [inlineEditMode, setInlineEditMode] = useState(false);
  const [selection, setSelection] = useState<PrototypeSelection | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [exported, setExported] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  // 对比状态提升到 store（P2：左侧统一历史面板选版、右侧对比浮层渲染共享）。
  const compareIds = useDesignStore((s) => s.compareIds);
  const comparing = useDesignStore((s) => s.comparing);
  const setComparing = useDesignStore((s) => s.setComparing);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // proto 版本动作（设主版/淘汰/回最新）与左侧统一历史面板共用同一套。
  const { pin: handlePin, discard: handleDiscardVariant, backToLatest } = useProtoVersionActions();

  const viewing = viewingVersionPath !== null;

  // 活跃 proto 版本（最新在前），供对比浮层定位；过滤已淘汰。
  const activeProtoVariants = useMemo(
    () =>
      activeVariants(spine)
        .filter((v) => v.kind === 'proto-html')
        .sort((a, b) => b.createdAt - a.createdAt),
    [spine],
  );

  const compareA = activeProtoVariants.find((v) => v.id === compareIds[0]);
  const compareB = activeProtoVariants.find((v) => v.id === compareIds[1]);

  // 全屏态下 Esc 退出。
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const handleOpenBrowser = async (): Promise<void> => {
    if (!selectedRunDir) return;
    const proto = (await findRunHtml(selectedRunDir)) ?? `${selectedRunDir}/prototype.html`;
    await openInDefaultApp(proto);
  };

  const handleExport = async (): Promise<void> => {
    if (!previewHtml) return;
    const saved = await saveHtmlToDownloads(prototypeExportName(Date.now()), previewHtml);
    if (saved) {
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    }
  };

  // 原型 → 矢量 PDF：走主进程 playwright page.pdf()。chromium 不可用时报失败、
  // 用户可改用「导出 HTML」兜底（不阻塞、不崩）。
  const handleExportPdf = async (): Promise<void> => {
    if (!previewHtml || exportingPdf) return;
    setExportingPdf(true);
    const res = await exportPrototypePdf(previewHtml, prototypePdfExportName(Date.now()));
    setExportingPdf(false);
    if (res.filePath) {
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    } else {
      window.alert(t.design.actionExportPdfFailed);
    }
  };

  // 看历史版本时强制退出圈选/就地编辑（避免在只读历史版上残留编辑态）。
  useEffect(() => {
    if (viewing) {
      setSelectMode(false);
      setInlineEditMode(false);
    }
  }, [viewing]);

  const handleRollback = async (): Promise<void> => {
    if (!selectedRunDir || !viewingVersionPath) return;
    const html = await readWorkspaceFile(viewingVersionPath);
    if (html == null) return;
    const proto = (await findRunHtml(selectedRunDir)) ?? `${selectedRunDir}/prototype.html`;
    await writeWorkspaceFile(proto, html);
    useDesignStore.getState().setPreviewHtml(html);
    useDesignStore.getState().setViewingVersion(null);
  };

  // 监听 srcDoc 注入脚本发来的圈选消息：校验来自本 iframe + 形状合法，
  // 命中即设为选中目标并退出圈选模式（opaque origin 不可信，只认 source/type + contentWindow）。
  useEffect(() => {
    if (!selectMode) return;
    const handler = (e: MessageEvent): void => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const payload = parseProtoSelectMessage(e.data);
      if (!payload) return;
      setSelection(payload);
      setSelectMode(false);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [selectMode]);

  // 就地文本编辑回写（CD-Parity §3）：blur 时 iframe 上报 {selector,newText}，父侧按 selector
  // 改 *canonical* prototype.html（非被注入加工过的 srcDoc）落盘 + 刷新 previewHtml。免 AI、零
  // token、不自动建 variant（想留档由用户手动「存版本」走现有 captureVersion）。与圈选 handler
  // 物理隔离：仅 inlineEditMode 开时注册、只认 PROTO_TEXT_EDIT_MESSAGE。
  const applyInlineEdit = async (selector: string, newText: string): Promise<void> => {
    const runDir = useDesignStore.getState().selectedRunDir;
    if (!runDir) return;
    // canonical = 磁盘 prototype.html 原文（zustand previewHtml 是其只读镜像，未含注入态）。
    const canonical = (await readRunHtml(runDir)) ?? useDesignStore.getState().previewHtml;
    if (canonical == null) return;
    const updated = applyTextEdit(canonical, selector, newText);
    if (updated === canonical) {
      // 未命中 / 叶子限制 / 表格无 tbody 等导致回写未生效：给用户反馈，避免「改了没生效」
      // 的静默数据丢失观感（CD-Parity §3 FIX 6）。
      window.alert(t.design.inlineEditNoOp);
      return;
    }
    const proto = (await findRunHtml(runDir)) ?? `${runDir}/prototype.html`;
    await writeWorkspaceFile(proto, updated);
    // 仅当用户仍停在该 run 才刷新，避免期间切走被旧内容覆盖。
    if (useDesignStore.getState().selectedRunDir === runDir) {
      useDesignStore.getState().setPreviewHtml(updated);
    }
  };

  useEffect(() => {
    if (!inlineEditMode) return;
    const handler = (e: MessageEvent): void => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const payload = parseProtoTextEditMessage(e.data);
      if (!payload) return;
      void applyInlineEdit(payload.selector, payload.newText);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
    // applyInlineEdit 只读 store getState/refs，无需进依赖；inlineEditMode 切换即重挂。
  }, [inlineEditMode]);

  // 演示稿（厚版二期）→ 有大纲则进编辑器（逐页预览 + 就地改字），否则占位引导。
  if (isSlidesOutput(outputType)) {
    return <SlidesPreview />;
  }

  // 设计稿 / 信息图 / 视频 → konva 无限画布；交互原型（网页）→ HTML iframe。
  if (isCanvasOutput(outputType)) {
    return <DesignCanvas />;
  }

  if (previewHtml) {
    const width = designDeviceWidth(device);
    const framed = device !== 'desktop';
    // 注入顺序：滚动条样式（head 起始）→ 换肤 hue-rotate（head 末尾，覆盖原型样式）→
    // 圈选 / 就地编辑脚本（互斥，同一时刻至多注入其一）。
    // 都只在预览渲染期注入；导出/快照走 previewHtml 原文，不含任何注入内容。
    const themed = injectThemeOverride(injectPreviewStyle(previewHtml), palette);
    const srcDoc = injectInlineEditScript(
      injectSelectionScript(themed, selectMode),
      inlineEditMode,
    );
    return (
      <div
        className={
          fullscreen
            ? 'fixed inset-0 z-50 flex flex-col bg-zinc-950' // ds-allow 预览面板全屏布局容器（非 modal：无遮罩/无 aria-modal/无 focus trap）
            : 'relative flex h-full w-full flex-col'
        }
      >
        {comparing && compareA && compareB && (
          <VariantCompareView
            variantA={compareA}
            variantB={compareB}
            runDir={selectedRunDir}
            onPin={handlePin}
            onDiscard={handleDiscardVariant}
            onClose={() => setComparing(false)}
          />
        )}
        {/* 版本控件（看版/对比/定稿）已并入左侧 composer 统一历史面板（DesignProtoHistory）。 */}
        <div className="relative flex h-10 shrink-0 items-center justify-center border-b border-white/[0.06] px-3">
          <div className="flex items-center gap-2">
            <DeviceSwitch device={device} onChange={setDevice} />
            <PaletteSwitch palette={palette} onChange={setPalette} />
          </div>
          <div className="absolute right-3 flex items-center gap-1">
            {/* ds-allow:start 设计预览工具栏沿用旧裸 button 样式（与同栏圈选/导出/全屏按钮一致）；design-mode W3 收口时统一迁 primitive */}
            {!viewing && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    // 互斥：开圈选即关就地编辑。
                    setInlineEditMode(false);
                    setSelectMode((v) => !v);
                  }}
                  aria-pressed={selectMode}
                  title={selectMode ? t.design.selectActiveHint : t.design.selectToggle}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
                    selectMode
                      ? 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200'
                      : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <MousePointerClick className="h-3.5 w-3.5" />
                  <span>{t.design.selectToggle}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // 互斥：开就地编辑即关圈选。
                    setSelectMode(false);
                    setSelection(null);
                    setInlineEditMode((v) => !v);
                  }}
                  aria-pressed={inlineEditMode}
                  title={inlineEditMode ? t.design.inlineEditActiveHint : t.design.inlineEditToggle}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
                    inlineEditMode
                      ? 'border-sky-400/40 bg-sky-400/10 text-sky-200'
                      : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span>{t.design.inlineEditToggle}</span>
                </button>
              </>
            )}
            {/* ds-allow:end */}
            <IconButton
              variant="outline"
              size="md"
              onClick={() => void handleOpenBrowser()}
              title={t.design.actionOpenBrowser}
              aria-label={t.design.actionOpenBrowser}
              icon={<ExternalLink className="h-3.5 w-3.5" />}
            />
            {/* ds-allow:start 导出按钮有 exported 成功态切到自定义 emerald 边框/底/字（无对应 IconButton variant，className 覆盖 bg 在 Tailwind 下不可靠） */}
            <button
              type="button"
              onClick={() => void handleExport()}
              title={exported ? t.design.actionExported : t.design.actionExport}
              aria-label={exported ? t.design.actionExported : t.design.actionExport}
              className={`rounded-md border p-1.5 transition-colors ${
                exported
                  ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                  : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            {/* ds-allow:end */}
            {/* ds-allow:start 设计预览工具栏沿用旧裸 button 样式，与同栏导出 HTML/全屏按钮一致；design-mode 整体 W3 收口时统一迁 primitive */}
            <button
              type="button"
              onClick={() => void handleExportPdf()}
              disabled={exportingPdf}
              title={exportingPdf ? t.design.actionExportingPdf : t.design.actionExportPdf}
              className="rounded-md border border-white/[0.08] p-1.5 text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-50"
            >
              {exportingPdf ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileDown className="h-3.5 w-3.5" />
              )}
            </button>
            {/* ds-allow:end */}
            <IconButton
              variant="outline"
              size="md"
              onClick={() => setFullscreen((v) => !v)}
              title={fullscreen ? t.design.actionExitFullscreen : t.design.actionFullscreen}
              aria-label={fullscreen ? t.design.actionExitFullscreen : t.design.actionFullscreen}
              icon={fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            />
          </div>
        </div>
        <div
          className={`flex min-h-0 flex-1 justify-center overflow-auto ${
            framed ? 'bg-zinc-900 p-4' : ''
          }`}
        >
          <iframe
            ref={iframeRef}
            title="design-preview"
            srcDoc={srcDoc}
            style={{ width, maxWidth: '100%' }}
            // 设备框模式下 iframe 底色取暗色，让滚动条 gutter 透出的底与机身/暗色原型融合，
            // 不再露出刺眼白条；桌面满宽无机身，保留白底（空白原型在白底上更自然）。
            className={`h-full border-0 ${framed ? 'rounded-lg bg-zinc-900 shadow-2xl' : 'w-full bg-white'}`}
            sandbox="allow-scripts"
          />
        </div>
        {viewing ? (
          <ViewingBanner
            onRollback={() => void handleRollback()}
            onBackToLatest={() => void backToLatest()}
          />
        ) : (
          <ContinueEditBar selection={selection} onClearSelection={() => setSelection(null)} />
        )}
      </div>
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
      {status === 'generating' ? (
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> {t.design.previewGenerating}
        </span>
      ) : (
        t.design.previewEmpty
      )}
    </div>
  );
};

export const DesignWorkspace: React.FC = () => {
  const { t } = useI18n();
  const [brandOpen, setBrandOpen] = useState(false);

  // 刷新/重开恢复：若有持久化的选中生成且当前无预览内容，回读其产物。
  useEffect(() => {
    const st = useDesignStore.getState();
    if (st.selectedRunDir && !st.previewHtml && st.status === 'idle') {
      void loadRun(st.selectedRunDir);
    }
  }, []);

  // 画布恢复：runDir 已持久化但节点为空（刷新后）→ 从磁盘 canvas.json 重载（共享 hook，与 DesignCanvasTab 同源）。
  useRestoreCanvasFromDisk();

  return (
    <FullScreenPage testId="design-workspace">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-fuchsia-300" />
          <span className="text-sm text-zinc-200">{t.design.title}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<BadgeCheck className="h-4 w-4" />}
            onClick={() => setBrandOpen(true)}
          >
            {t.design.brand.open}
          </Button>
          <WorkspaceModeSwitch />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <Composer />
        <div className="min-w-0 flex-1 bg-zinc-950">
          <PreviewPane />
        </div>
      </div>
      <BrandManager isOpen={brandOpen} onClose={() => setBrandOpen(false)} />
    </FullScreenPage>
  );
};
