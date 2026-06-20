// 设计工作区（Kun 借鉴：设计 tab）。左侧 composer（历史 + 需求 + 设计上下文 + 产物
// 类型）+ 右侧预览。v1 把「交互原型」整条闭环打通；设计稿/信息图占位标「即将」。
// 所有面向用户的文案统一走 i18n（t.design.*），避免中英混排。
import React, { useEffect, useState } from 'react';
import { Palette, Sparkles, Loader2, AlertCircle, History, ChevronRight } from 'lucide-react';
import { FullScreenPage } from '../features/shared/FullScreenPage';
import { WorkspaceModeSwitch } from './WorkspaceModeSwitch';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';
import { useDesignGeneration } from './useDesignGeneration';
import { useDesignCanvasGeneration } from './useDesignCanvasGeneration';
import { useDesignCanvasStore } from './designCanvasStore';
import { loadCanvasDoc } from './designCanvasPersistence';
import { readRunHtml } from './designFiles';
import { DesignCanvas } from './DesignCanvas';
import { DESIGN_ASPECT_RATIOS, type DesignOutputType, type DesignSurface } from './designTypes';

/** 图像类产物（走 konva 画布）：设计稿 / 信息图。交互原型仍走 HTML iframe。 */
function isImageOutput(t: DesignOutputType): boolean {
  return t === 'mockup' || t === 'infographic';
}

/** 加载某次历史生成的产物到预览。 */
async function loadRun(runDir: string): Promise<void> {
  useDesignStore.getState().selectRun(runDir);
  const html = await readRunHtml(runDir);
  // 期间未被其它操作取代才写入。
  if (html && useDesignStore.getState().previewPath === runDir) {
    useDesignStore.getState().setPreviewHtml(html);
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
        </div>
      )}
    </div>
  );
};

const Composer: React.FC = () => {
  const { t } = useI18n();
  const s = useDesignStore();
  const { generate: generatePrototype } = useDesignGeneration();
  const { generate: generateCanvas } = useDesignCanvasGeneration();
  const canvasGenerating = useDesignCanvasStore((c) => c.generating);
  const canvasError = useDesignCanvasStore((c) => c.error);

  const outputTypes: Array<{ type: DesignOutputType; label: string }> = [
    { type: 'prototype', label: t.design.outputPrototype },
    { type: 'mockup', label: t.design.outputMockup },
    { type: 'infographic', label: t.design.outputInfographic },
  ];
  const imageMode = isImageOutput(s.outputType);
  const generating = imageMode ? canvasGenerating : s.status === 'generating';
  const error = imageMode ? canvasError : s.error;
  const onGenerate = imageMode ? generateCanvas : generatePrototype;
  const surfaces: Array<{ value: DesignSurface; label: string }> = [
    { value: 'brand', label: t.design.surfaceBrand },
    { value: 'product', label: t.design.surfaceProduct },
  ];

  return (
    <div className="flex flex-col gap-5 w-80 shrink-0 border-r border-white/[0.06] p-4 overflow-y-auto">
      <HistorySection />

      {/* 产物类型 */}
      <div className="flex gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
        {outputTypes.map(({ type, label }) => (
          <button
            key={type}
            type="button"
            onClick={() => s.setOutputType(type)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
              s.outputType === type
                ? 'bg-white/[0.10] text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {label}
          </button>
        ))}
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
            value={s.brandColor || '#3b82f6'}
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
        </div>
      </div>

      {/* Surface */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-zinc-400">{t.design.surfaceLabel}</span>
        <div className="flex gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
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
        </div>
      </div>

      {/* 出图尺寸（仅图像产物） */}
      {imageMode && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-zinc-400">{t.design.aspectRatioLabel}</span>
          <div className="flex flex-wrap gap-1.5">
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
          </div>
        </div>
      )}

      {/* 生成 */}
      <button
        type="button"
        onClick={() => void onGenerate()}
        disabled={generating}
        className="mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
      >
        {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {generating ? t.design.generating : t.design.generate}
      </button>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

const PreviewPane: React.FC = () => {
  const { t } = useI18n();
  const outputType = useDesignStore((s) => s.outputType);
  const previewHtml = useDesignStore((s) => s.previewHtml);
  const status = useDesignStore((s) => s.status);

  // 设计稿 / 信息图 → konva 无限画布；交互原型 → HTML iframe。
  if (isImageOutput(outputType)) {
    return <DesignCanvas />;
  }

  if (previewHtml) {
    return (
      <iframe
        title="design-preview"
        srcDoc={previewHtml}
        className="h-full w-full border-0 bg-white"
        sandbox="allow-scripts"
      />
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

  // 刷新/重开恢复：若有持久化的选中生成且当前无预览内容，回读其产物。
  useEffect(() => {
    const st = useDesignStore.getState();
    if (st.selectedRunDir && !st.previewHtml && st.status === 'idle') {
      void loadRun(st.selectedRunDir);
    }
  }, []);

  // 画布恢复：runDir 已持久化但节点为空（刷新后）→ 从磁盘 canvas.json 重载。
  useEffect(() => {
    const cs = useDesignCanvasStore.getState();
    if (!cs.runDir || cs.nodes.length > 0) return;
    const runDir = cs.runDir;
    void loadCanvasDoc(runDir).then((doc) => {
      const cur = useDesignCanvasStore.getState();
      if (cur.runDir === runDir && cur.nodes.length === 0) {
        cur.loadDoc(runDir, doc);
      }
    });
  }, []);

  return (
    <FullScreenPage testId="design-workspace">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-fuchsia-300" />
          <span className="text-sm text-zinc-200">{t.design.title}</span>
        </div>
        <WorkspaceModeSwitch />
      </div>
      <div className="flex min-h-0 flex-1">
        <Composer />
        <div className="min-w-0 flex-1 bg-zinc-950">
          <PreviewPane />
        </div>
      </div>
    </FullScreenPage>
  );
};
