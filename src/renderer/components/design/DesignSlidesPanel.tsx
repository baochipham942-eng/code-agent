// 厚版演示稿面板（二期）侧栏：需求(topic) + 页数 → 生成大纲 → 右侧编辑 → 生成演示稿。
// SlideData[] 单一真源在 designSlidesStore；大纲编辑器在右侧 PreviewPane。
import React from 'react';
import { Loader2, Presentation, ListOrdered, CheckCircle2, AlertCircle, RotateCcw } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';
import { useDesignSlidesStore } from './designSlidesStore';
import { generateSlidesOutline, generateSlidesDeck } from './designFiles';
import { sanitizeOutline } from './slidesOutlineOps';
import { canvasPptxExportName } from './designTypes';

const MIN_SLIDES = 4;
const MAX_SLIDES = 20;
const DEFAULT_SLIDES = 10;

export const DesignSlidesPanel: React.FC = () => {
  const { t } = useI18n();
  const requirement = useDesignStore((s) => s.requirement);
  const [slidesCount, setSlidesCount] = React.useState(DEFAULT_SLIDES);
  const [aiOutline, setAiOutline] = React.useState(false);
  const [fellBack, setFellBack] = React.useState(false);

  const outline = useDesignSlidesStore((s) => s.outline);
  const buildingOutline = useDesignSlidesStore((s) => s.buildingOutline);
  const generating = useDesignSlidesStore((s) => s.generating);
  const result = useDesignSlidesStore((s) => s.result);
  const error = useDesignSlidesStore((s) => s.error);
  const store = useDesignSlidesStore;

  const topic = requirement.trim();
  const hasOutline = !!outline && outline.length > 0;

  const onBuildOutline = async (): Promise<void> => {
    if (!topic || buildingOutline) return;
    setFellBack(false);
    store.setState({ buildingOutline: true, error: null, result: null });
    const res = await generateSlidesOutline({ topic, slidesCount, ai: aiOutline });
    if (res.slides) {
      store.setState({ outline: res.slides, buildingOutline: false });
      // 请求了 AI 但实际降级（无 key/失败）→ 提示用户
      if (aiOutline && res.aiUsed === false) setFellBack(true);
    } else {
      store.setState({ error: res.error ?? t.design.slidesGenerateError, buildingOutline: false });
    }
  };

  const onGenerate = async (): Promise<void> => {
    if (generating) return;
    if (!hasOutline && !topic) return;
    store.setState({ generating: true, error: null, result: null });
    const res = await generateSlidesDeck({
      topic: topic || undefined,
      slidesCount,
      slides: hasOutline ? sanitizeOutline(outline!) : undefined,
      outputName: canvasPptxExportName(Date.now()),
    });
    if (res.filePath) {
      store.setState({ result: { filePath: res.filePath, slidesCount: res.slidesCount }, generating: false });
    } else {
      store.setState({ error: res.error ?? t.design.slidesGenerateError, generating: false });
    }
  };

  const busy = buildingOutline || generating;

  return (
    <div className="flex flex-col gap-3">
      {/* 页数（仅生成大纲前可调；已有大纲后以实际页数为准） */}
      {!hasOutline && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-zinc-400">
            {t.design.slidesCountLabel}：<span className="font-mono text-zinc-300">{slidesCount}</span>
          </span>
          <input
            type="range"
            min={MIN_SLIDES}
            max={MAX_SLIDES}
            step={1}
            value={slidesCount}
            onChange={(e) => setSlidesCount(Number(e.target.value))}
            aria-label={t.design.slidesCountLabel}
          />
        </label>
      )}

      {/* AI 增强大纲开关（付费，opt-in；默认走免费确定性模板） */}
      {!hasOutline && (
        <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-snug text-zinc-400">
          <input
            type="checkbox"
            checked={aiOutline}
            onChange={(e) => setAiOutline(e.target.checked)}
            className="mt-0.5 accent-fuchsia-500"
          />
          <span>
            {t.design.slidesAiOutline}
            {aiOutline && <span className="text-amber-300/80">（{t.design.slidesAiCostHint}）</span>}
          </span>
        </label>
      )}

      {/* 第一步：生成大纲 */}
      {/* ds-allow:start 大纲生成按钮：次级动作用描边样式 */}
      <button
        type="button"
        onClick={() => void onBuildOutline()}
        disabled={!topic || busy}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] px-3 py-2 text-sm text-zinc-200 transition-colors hover:text-white disabled:opacity-50"
      >
        {buildingOutline ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListOrdered className="h-4 w-4" />}
        {hasOutline ? t.design.slidesRebuildOutline : t.design.slidesBuildOutline}
      </button>
      {/* ds-allow:end */}

      {hasOutline && (
        <div className="flex items-center justify-between text-[11px] text-zinc-500">
          <span>{t.design.slidesOutlineReady}（{outline!.length}）</span>
          <button
            type="button"
            onClick={() => store.setState({ outline: null, result: null, error: null })}
            className="inline-flex items-center gap-1 hover:text-zinc-300"
          >
            <RotateCcw className="h-3 w-3" />
            {t.design.slidesResetOutline}
          </button>
        </div>
      )}

      {/* 第二步：生成演示稿（据编辑后大纲，或无大纲时直接据 topic） */}
      {/* ds-allow:start 演示稿主 CTA 用设计区品牌色 bg-fuchsia-500/90 */}
      <button
        type="button"
        onClick={() => void onGenerate()}
        disabled={(!hasOutline && !topic) || busy}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
      >
        {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Presentation className="h-4 w-4" />}
        {generating ? t.design.slidesGenerating : t.design.slidesGenerate}
      </button>
      {/* ds-allow:end */}

      {!topic && !hasOutline && (
        <p className="text-[11px] leading-snug text-zinc-500">{t.design.slidesNeedTopic}</p>
      )}

      {fellBack && (
        <p className="text-[11px] leading-snug text-amber-300/80">{t.design.slidesAiFellBack}</p>
      )}

      {result && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-[11px] leading-snug text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t.design.slidesDone}
            {typeof result.slidesCount === 'number' ? `（${result.slidesCount}）` : ''}
            <br />
            <span className="break-all text-emerald-300/80">{result.filePath}</span>
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-[11px] leading-snug text-red-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};
