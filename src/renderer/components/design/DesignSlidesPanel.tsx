// 厚版演示稿面板（二期 MVP）：需求(topic) + 页数 → 主进程 slidesGenerator 真排版 deck
// → 导出到「下载」。当前 MVP 直出 PPTX；大纲编辑 / 画布预览 / 就地改字为后续增量。
import React, { useState } from 'react';
import { Loader2, Presentation, CheckCircle2, AlertCircle } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';
import { generateSlidesDeck } from './designFiles';
import { canvasPptxExportName } from './designTypes';

const MIN_SLIDES = 4;
const MAX_SLIDES = 20;
const DEFAULT_SLIDES = 10;

export const DesignSlidesPanel: React.FC = () => {
  const { t } = useI18n();
  const requirement = useDesignStore((s) => s.requirement);
  const [slidesCount, setSlidesCount] = useState(DEFAULT_SLIDES);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ filePath: string; slidesCount?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const topic = requirement.trim();
  const canGenerate = topic.length > 0 && !generating;

  const onGenerate = async (): Promise<void> => {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);
    setResult(null);
    const res = await generateSlidesDeck({
      topic,
      slidesCount,
      outputName: canvasPptxExportName(Date.now()),
    });
    if (res.filePath) {
      setResult({ filePath: res.filePath, slidesCount: res.slidesCount });
    } else {
      setError(res.error ?? t.design.slidesGenerateError);
    }
    setGenerating(false);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 页数 */}
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

      {/* 生成（free：确定性排版，不调付费模型） */}
      {/* ds-allow:start 演示稿生成 CTA 用设计区品牌色 bg-fuchsia-500/90（与图/网页生成按钮一致） */}
      <button
        type="button"
        onClick={() => void onGenerate()}
        disabled={!canGenerate}
        className="mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
      >
        {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Presentation className="h-4 w-4" />}
        {generating ? t.design.slidesGenerating : t.design.slidesGenerate}
      </button>
      {/* ds-allow:end */}

      {!topic && <p className="text-[11px] leading-snug text-zinc-500">{t.design.slidesNeedTopic}</p>}

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
