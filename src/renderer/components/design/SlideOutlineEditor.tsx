// 演示稿大纲编辑器（厚版二期）：逐页卡片预览 + 就地改字 + 增删/排序。
// 读写 designSlidesStore（SlideData[] 单一真源），点「生成演示稿」据此排版导出。
import React from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, X } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useDesignSlidesStore } from './designSlidesStore';
import type { SlideOutlineItem } from './slidesOutlineOps';

function slideKind(s: SlideOutlineItem, t: ReturnType<typeof useI18n>['t']): string {
  if (s.isTitle) return t.design.slidesKindCover;
  if (s.isEnd) return t.design.slidesKindEnd;
  return t.design.slidesKindContent;
}

const SlideCard: React.FC<{ slide: SlideOutlineItem; index: number; total: number }> = ({
  slide,
  index,
  total,
}) => {
  const { t } = useI18n();
  const s = useDesignSlidesStore;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
          <span className="font-mono text-zinc-400">{index + 1}</span>
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-zinc-400">{slideKind(slide, t)}</span>
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => s.getState().reorderSlide(index, -1)}
            disabled={index === 0}
            title={t.design.slidesMoveUp}
            className="rounded p-1 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-30"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => s.getState().reorderSlide(index, 1)}
            disabled={index === total - 1}
            title={t.design.slidesMoveDown}
            className="rounded p-1 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-30"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => s.getState().deleteSlide(index)}
            disabled={total <= 1}
            title={t.design.slidesDeletePage}
            className="rounded p-1 text-zinc-500 transition-colors hover:text-red-300 disabled:opacity-30"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 标题（就地改字） */}
      <input
        value={slide.title}
        onChange={(e) => s.getState().editSlide(index, { title: e.target.value })}
        placeholder={t.design.slidesTitlePlaceholder}
        className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-sm font-medium text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
      />

      {/* 副标题（仅封面页） */}
      {slide.isTitle && (
        <input
          value={slide.subtitle ?? ''}
          onChange={(e) => s.getState().editSlide(index, { subtitle: e.target.value })}
          placeholder={t.design.slidesSubtitlePlaceholder}
          className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
        />
      )}

      {/* 要点（就地改字 + 增删） */}
      {!slide.isTitle && (
        <div className="flex flex-col gap-1.5">
          {slide.points.map((p, pi) => (
            <div key={pi} className="flex items-center gap-1.5">
              <span className="text-zinc-600">•</span>
              <input
                value={p}
                onChange={(e) => s.getState().editPoint(index, pi, e.target.value)}
                placeholder={t.design.slidesPointPlaceholder}
                className="flex-1 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => s.getState().deletePoint(index, pi)}
                title={t.design.slidesDeletePoint}
                className="rounded p-1 text-zinc-600 transition-colors hover:text-red-300"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => s.getState().appendPoint(index)}
            className="inline-flex w-fit items-center gap-1 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <Plus className="h-3 w-3" />
            {t.design.slidesAddPoint}
          </button>
        </div>
      )}

      {/* 在此页后插入 */}
      <button
        type="button"
        onClick={() => s.getState().insertSlideAfter(index)}
        className="inline-flex w-fit items-center gap-1 text-[11px] text-zinc-600 transition-colors hover:text-fuchsia-300"
      >
        <Plus className="h-3 w-3" />
        {t.design.slidesInsertAfter}
      </button>
    </div>
  );
};

export const SlideOutlineEditor: React.FC = () => {
  const { t } = useI18n();
  const outline = useDesignSlidesStore((s) => s.outline);
  if (!outline || outline.length === 0) return null;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/[0.06] px-4 text-xs text-zinc-400">
        <span>{t.design.slidesOutlineTitle}</span>
        <span className="text-zinc-500">{t.design.slidesOutlineHint}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2">
          {outline.map((slide, i) => (
            <SlideCard key={i} slide={slide} index={i} total={outline.length} />
          ))}
        </div>
      </div>
    </div>
  );
};
