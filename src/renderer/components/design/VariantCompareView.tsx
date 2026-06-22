// 通用 variant 并排对比浮层（canvas 与 proto 共用）。两版等高并排，看清差异。
// 按 kind 渲染：canvas-image → <img>(磁盘懒加载)；proto-html → <iframe srcDoc>。
// pin/discard 动作由调用方注入（各自维护 store/落盘），本组件只负责呈现与触发。
import React, { useEffect, useState } from 'react';
import { X, Star, Trash2 } from 'lucide-react';
import { IconButton } from '../primitives';
import { useI18n } from '../../hooks/useI18n';
import { readWorkspaceImageAsDataUrl, readWorkspaceFile } from './designFiles';
import { injectPreviewStyle } from './designPreviewInject';
import type { Variant } from './variantSpine';

type T = ReturnType<typeof useI18n>['t'];

/** variant 标题：优先 label，否则按 kind/op 给中性回退（全走 i18n）。 */
function variantLabel(v: Variant, t: T): string {
  if (v.label) return v.label;
  if (v.kind === 'canvas-image') {
    return v.parentId ? t.design.versionEdited : t.design.versionOriginal;
  }
  return v.op === 'continueEdit' ? t.design.continueEditTitle : t.design.title;
}

const Pane: React.FC<{
  variant: Variant;
  runDir: string | null;
  onPin: () => void;
  onDiscard: () => void;
}> = ({ variant, runDir, onPin, onDiscard }) => {
  const { t } = useI18n();
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (variant.kind === 'canvas-image') {
        const { src } = variant.payload as { src: string };
        const u = /^(data:|https?:)/.test(src)
          ? src
          : runDir
            ? await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${src}`)
            : null;
        if (alive) setImgUrl(u);
      } else {
        const { htmlPath } = variant.payload as { htmlPath: string };
        const h = await readWorkspaceFile(htmlPath);
        if (alive) setHtml(h);
      }
    })();
    return () => {
      alive = false;
    };
  }, [variant, runDir]);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-white/[0.1] bg-zinc-950">
        {variant.kind === 'canvas-image' ? (
          imgUrl ? (
            <img src={imgUrl} alt="version" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-zinc-600">…</span>
          )
        ) : html != null ? (
          <iframe
            title="proto-version"
            srcDoc={injectPreviewStyle(html)}
            sandbox="allow-scripts"
            className="pointer-events-none h-full w-full border-0 bg-white"
          />
        ) : (
          <span className="text-xs text-zinc-600">…</span>
        )}
        {variant.pinned && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-emerald-500/90 px-1.5 py-0.5 text-[10px] text-white">
            <Star className="h-3 w-3" /> {t.design.mainVersion}
          </span>
        )}
      </div>
      <p className="line-clamp-2 text-[11px] text-zinc-400" title={variantLabel(variant, t)}>
        {variantLabel(variant, t)}
      </p>
      <div className="flex gap-2">
        {/* ds-allow:start 定稿 CTA 用全宽 emerald 确认色（Button primary 是蓝色渐变，会丢"设为主版"的成功语义）+ discard 用透明描边+红 hover（无对应 Button variant），两者均无法不回归地映射 primitive */}
        <button
          type="button"
          onClick={onPin}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-500/90 px-2 py-1.5 text-xs text-white hover:bg-emerald-500"
        >
          <Star className="h-3.5 w-3.5" /> {t.design.setMainVersion}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-white/[0.1] px-2 py-1.5 text-xs text-zinc-400 hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" /> {t.design.discardVersion}
        </button>
        {/* ds-allow:end */}
      </div>
    </div>
  );
};

export const VariantCompareView: React.FC<{
  variantA: Variant;
  variantB: Variant;
  runDir: string | null;
  onPin: (id: string) => void;
  onDiscard: (id: string) => void;
  onClose: () => void;
}> = ({ variantA, variantB, runDir, onPin, onDiscard, onClose }) => {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 z-10 flex flex-col gap-3 bg-zinc-950/85 p-6 backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-200">{t.design.compareTitle}</span>
        <IconButton
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label={t.common.close}
          icon={<X className="h-4 w-4" />}
        />
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
        <Pane
          variant={variantA}
          runDir={runDir}
          onPin={() => onPin(variantA.id)}
          onDiscard={() => onDiscard(variantA.id)}
        />
        <Pane
          variant={variantB}
          runDir={runDir}
          onPin={() => onPin(variantB.id)}
          onDiscard={() => onDiscard(variantB.id)}
        />
      </div>
    </div>
  );
};
