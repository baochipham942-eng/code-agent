import React, { useEffect, useState } from 'react';
import { Image as KonvaImage, Rect as KonvaRect, Text as KonvaText } from 'react-konva';
import type Konva from 'konva';
import { useI18n } from '../../hooks/useI18n';
import { readWorkspaceImageAsDataUrl } from './designFiles';
import {
  formatDurationLabel,
  isReferenceNode,
  type CanvasImageNode,
  type CanvasVideoNode,
} from './designCanvasTypes';
import { classifyPointerDragIntent } from './canvasCameraInput';

function useNodeImage(runDir: string | null, src: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      let url: string | null = src;
      if (!/^(data:|https?:)/.test(src)) {
        url = runDir ? await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${src}`) : null;
      }
      if (!url || !alive) return;
      const image = new window.Image();
      image.onload = () => {
        if (alive) setImg(image);
      };
      image.src = url;
    })();
    return () => {
      alive = false;
    };
  }, [runDir, src]);
  return img;
}

export const CanvasImage: React.FC<{
  node: CanvasImageNode;
  runDir: string | null;
  selected: boolean;
  panModifierActive: boolean;
  onSelect: (additive: boolean) => void;
  onViewDiff: (node: CanvasImageNode) => void;
}> = ({ node, runDir, selected, panModifierActive, onSelect, onViewDiff }) => {
  const { t } = useI18n();
  const img = useNodeImage(runDir, node.src);
  if (!img) return null;
  const pick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void => {
    const evt = e.evt as MouseEvent;
    if (
      'button' in evt &&
      classifyPointerDragIntent({ button: evt.button, spaceKey: panModifierActive }) === 'pan'
    ) {
      return;
    }
    onSelect(Boolean(evt.shiftKey || evt.metaKey));
  };
  // 徽标字号随相机缩放保持视觉恒定（用 1/scale 反算近似，简化为固定值即可）。
  const badge = Math.max(14, Math.round(node.width * 0.03));
  // T4 一致性徽章：clean=未选区守住(绿)；locked=已锁定未选区(琥珀, 可点开 diff 证据)。
  const c = node.consistency;
  const consistencyBadge = ((): React.ReactNode => {
    if (!c) return null;
    const isLocked = c.status === 'locked';
    const color = isLocked ? '#f59e0b' : '#10b981'; // ds-allow:viz konva 画布字面色，CSS 变量够不到
    const label = isLocked ? t.design.consistencyLocked : t.design.consistencyClean;
    const fs = badge;
    const padX = fs * 0.55;
    const pillW = Math.round(label.length * fs * 0.62 + padX * 2);
    const pillH = Math.round(fs * 1.7);
    const px = node.x + node.width - pillW - 8;
    const py = node.y + 8;
    const clickable = isLocked && Boolean(c.diffPath);
    const open = (): void => {
      if (clickable) onViewDiff(node);
    };
    return (
      <>
        <KonvaRect
          x={px}
          y={py}
          width={pillW}
          height={pillH}
          fill="rgba(9,9,11,0.78)"
          stroke={color}
          strokeWidth={1.5}
          cornerRadius={pillH / 2}
          listening={clickable}
          onMouseDown={open}
          onTap={open}
        />
        <KonvaText
          x={px}
          y={py + pillH * 0.26}
          width={pillW}
          align="center"
          text={label}
          fontSize={Math.round(fs * 0.72)}
          fill={color}
          listening={false}
        />
      </>
    );
  })();
  return (
    <>
      <KonvaImage
        image={img}
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        onMouseDown={pick}
        onTap={pick}
      />
      {isReferenceNode(node) && (
        <>
          <KonvaRect
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            stroke="#38bdf8" // ds-allow:viz konva 画布字面色，CSS 变量够不到（参考图 sky 标识）
            strokeWidth={2}
            dash={[4, 4]}
            listening={false}
          />
          <KonvaRect
            x={node.x + 6}
            y={node.y + 6}
            width={Math.round(t.design.referenceBadge.length * badge * 0.62 + badge * 1.1)}
            height={Math.round(badge * 1.7)}
            fill="rgba(56,189,248,0.18)" // ds-allow:viz 参考徽章底
            cornerRadius={Math.round(badge * 0.85)}
            listening={false}
          />
          <KonvaText
            x={node.x + 6}
            y={node.y + 6 + Math.round(badge * 0.42)}
            width={Math.round(t.design.referenceBadge.length * badge * 0.62 + badge * 1.1)}
            align="center"
            text={t.design.referenceBadge}
            fontSize={Math.round(badge * 0.72)}
            fill="#7dd3fc" // ds-allow:viz konva 画布字面色
            listening={false}
          />
        </>
      )}
      {node.chosen && (
        <>
          <KonvaRect
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            stroke="#10b981" // ds-allow:viz konva 画布字面色，CSS 变量够不到
            strokeWidth={3}
            listening={false}
          />
          <KonvaText
            x={node.x + 8}
            y={node.y + 8}
            text="★"
            fontSize={badge}
            fill="#10b981" // ds-allow:viz konva 画布字面色，CSS 变量够不到
            listening={false}
          />
        </>
      )}
      {selected && (
        <KonvaRect
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          stroke="#e879f9" // ds-allow:viz konva 画布字面色，CSS 变量够不到
          strokeWidth={2}
          dash={[10, 6]}
          listening={false}
        />
      )}
      {consistencyBadge}
    </>
  );
};

// P2 视频节点：poster 缩略图（有则懒加载，无则深色占位）+ 居中播放徽标 + 左下时长 +
// 选中/主版高亮（与 CanvasImage 同视觉语言）。点播放徽标打开 DOM <video> 浮层。
export const KonvaVideoNode: React.FC<{
  node: CanvasVideoNode;
  runDir: string | null;
  selected: boolean;
  panModifierActive: boolean;
  onSelect: (additive: boolean) => void;
  onPlay: () => void;
}> = ({ node, runDir, selected, panModifierActive, onSelect, onPlay }) => {
  const poster = useNodeImage(runDir, node.poster ?? '');
  const pick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void => {
    const evt = e.evt as MouseEvent;
    if (
      'button' in evt &&
      classifyPointerDragIntent({ button: evt.button, spaceKey: panModifierActive }) === 'pan'
    ) {
      return;
    }
    onSelect(Boolean(evt.shiftKey || evt.metaKey));
  };
  const play = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void => {
    e.cancelBubble = true;
    onPlay();
  };
  const cy = node.y + node.height / 2;
  const glyph = Math.max(28, Math.round(Math.min(node.width, node.height) * 0.18));
  const durFs = Math.max(12, Math.round(node.width * 0.04));
  return (
    <>
      {poster ? (
        <KonvaImage image={poster} x={node.x} y={node.y} width={node.width} height={node.height} onMouseDown={pick} onTap={pick} />
      ) : (
        <KonvaRect
          x={node.x} y={node.y} width={node.width} height={node.height}
          fill="#18181b" // ds-allow:viz konva 画布字面色，CSS 变量够不到
          cornerRadius={6} onMouseDown={pick} onTap={pick}
        />
      )}
      <KonvaText
        x={node.x}
        y={cy - glyph / 2}
        width={node.width}
        align="center"
        text="▶"
        fontSize={glyph}
        fill="rgba(255,255,255,0.92)"
        onMouseDown={play}
        onTap={play}
      />
      <KonvaText
        x={node.x + 8}
        y={node.y + node.height - durFs * 1.6}
        text={formatDurationLabel(node.durationSec)}
        fontSize={durFs}
        fill="rgba(255,255,255,0.85)"
        listening={false}
      />
      {node.chosen && (
        <KonvaRect
          x={node.x} y={node.y} width={node.width} height={node.height}
          stroke="#10b981" // ds-allow:viz konva 画布字面色，CSS 变量够不到
          strokeWidth={3} listening={false}
        />
      )}
      {selected && (
        <KonvaRect
          x={node.x} y={node.y} width={node.width} height={node.height}
          stroke="#e879f9" // ds-allow:viz konva 画布字面色，CSS 变量够不到
          strokeWidth={2} dash={[10, 6]} listening={false}
        />
      )}
    </>
  );
};
