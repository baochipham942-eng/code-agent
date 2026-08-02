// 设计画布的浮层/选择子组件（从 DesignCanvas 抽出，纯展示，无逻辑改动）：
// - VideoPlayOverlay：P2 视频播放浮层（DOM，镜像 DiffEvidenceOverlay）
// - DiffEvidenceOverlay：T4 diff 证据浮层（标红「模型偷改的未选区域」+ 度量）
// 文案走 i18n（t.design.*），不硬编码。
import React, { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { IconButton } from '../primitives';
import { useI18n } from '../../hooks/useI18n';
import { readWorkspaceImageAsDataUrl, readWorkspaceBinaryAsBlobUrl } from './designFiles';
import type { CanvasImageNode, CanvasVideoNode } from './designCanvasTypes';

// P2 视频播放浮层（DOM，镜像 DiffEvidenceOverlay）：把 mp4 读成 data URL 喂 <video> 就地播放。
export const VideoPlayOverlay: React.FC<{
  runDir: string | null;
  node: CanvasVideoNode;
  onClose: () => void;
}> = ({ runDir, node, onClose }) => {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    void (async () => {
      if (!runDir) return;
      // 视频走 Blob URL（非 data URL）——4MB mp4 的 data: URL 超浏览器 ~2MB 上限会 0:00 放不动。
      const blobUrl = await readWorkspaceBinaryAsBlobUrl(`${runDir.replace(/\/+$/, '')}/${node.src}`);
      if (alive) {
        created = blobUrl;
        setUrl(blobUrl);
      } else if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    })();
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [runDir, node.src]);
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-zinc-950/85 p-6">
      <IconButton
        onClick={onClose}
        className="absolute right-4 top-4"
        aria-label={t.design.videoPlayClose}
        icon={<X size={18} />}
      />
      {url ? (
        <video src={url} controls autoPlay className="max-h-[80%] max-w-[90%] rounded border border-white/20" />
      ) : (
        <Loader2 className="animate-spin text-zinc-500" size={20} />
      )}
    </div>
  );
};

// T4 diff 证据浮层：展示"模型偷改了哪些未选区域"（标红）+ 度量。
export const DiffEvidenceOverlay: React.FC<{
  runDir: string | null;
  node: CanvasImageNode;
  onClose: () => void;
}> = ({ runDir, node, onClose }) => {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const diffPath = node.consistency?.diffPath;
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!runDir || !diffPath) return;
      const data = await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${diffPath}`);
      if (alive) setUrl(data);
    })();
    return () => {
      alive = false;
    };
  }, [runDir, diffPath]);
  const c = node.consistency;
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-zinc-950/85 p-6">
      <div className="flex items-center gap-2 text-sm text-amber-300">
        <span>{t.design.diffEvidenceTitle}</span>
        <IconButton onClick={onClose} aria-label={t.design.diffClose} icon={<X size={16} />} />
      </div>
      {c && (
        <p className="text-[11px] text-zinc-400">
          {t.design.diffMaxDelta}: {Math.round(c.maxDelta)} · {t.design.diffChangedPixels}: {c.changedPixels}
        </p>
      )}
      {url ? (
        <img src={url} alt="diff" className="max-h-[70%] max-w-[90%] rounded border border-amber-500/40" />
      ) : (
        <Loader2 className="animate-spin text-zinc-500" size={20} />
      )}
      <p className="max-w-md text-center text-[11px] leading-snug text-zinc-500">{t.design.diffEvidenceHint}</p>
    </div>
  );
};
