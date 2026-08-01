// 画布右下角悬浮缩放控件（2026-08-01 K2 工单）：缩放读数 + 适配视口，两个，不占顶栏。
// - 读数跟随 camera.scale 实时更新（滚轮缩放时数字也动），读数本身即入口：点开档位菜单
//   （25/50/100/200 + 自定义输入），选中某档 = 以视口中心为锚点缩放到该比例。
// - 适配视口复用 computeFitCamera（由父组件传入 onFit），把全部可见节点重新装进视口。
// 缩放范围与滚轮缩放同源（canvasCameraInput 的 clamp = CANVAS_SCALE_MIN..MAX），两处不各定一套。
// 空画布不渲染（父组件按 canvasBare 门控）——没内容可缩放，适配视口也无意义。
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Maximize } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { GhostButton, IconButton } from '../primitives';
import { clamp } from './canvasCameraInput';
import type { CanvasCamera } from './designCanvasTypes';

const ZOOM_PRESETS = [25, 50, 100, 200];

interface DesignCanvasZoomControlsProps {
  camera: CanvasCamera;
  /** 画布视口像素尺寸（锚点 = 视口中心）。 */
  viewport: { w: number; h: number };
  onCameraChange: (camera: CanvasCamera) => void;
  /** 适配视口：父组件复用 computeFitCamera 重算相机。 */
  onFit: () => void;
}

export const DesignCanvasZoomControls: React.FC<DesignCanvasZoomControlsProps> = ({
  camera,
  viewport,
  onCameraChange,
  onFit,
}) => {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // 菜单开着时点控件外部收起。
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  // 以视口中心为锚点缩放到目标百分比；范围与滚轮缩放同源（clamp，两处不一致就是 bug）。
  const zoomToPercent = (percent: number): void => {
    if (!Number.isFinite(percent) || viewport.w <= 0 || viewport.h <= 0 || camera.scale <= 0) return;
    const scale = clamp(percent / 100);
    const cx = viewport.w / 2;
    const cy = viewport.h / 2;
    const worldX = (cx - camera.x) / camera.scale;
    const worldY = (cy - camera.y) / camera.scale;
    onCameraChange({ scale, x: cx - worldX * scale, y: cy - worldY * scale });
  };

  const applyPreset = (percent: number): void => {
    zoomToPercent(percent);
    setMenuOpen(false);
  };

  const applyDraft = (): void => {
    const percent = Number(draft);
    if (Number.isFinite(percent) && percent > 0) zoomToPercent(percent);
    setDraft('');
    setMenuOpen(false);
  };

  return (
    <div
      ref={rootRef}
      data-testid="design-canvas-zoom-controls"
      className="absolute bottom-4 right-4 z-10 flex items-center gap-1 rounded-lg border border-white/[0.1] bg-zinc-900/90 p-1 shadow-xl backdrop-blur"
    >
      <GhostButton
        size="sm"
        data-testid="design-canvas-zoom-readout"
        aria-label={t.design.zoomLevel}
        aria-expanded={menuOpen}
        title={t.design.zoomLevel}
        rightIcon={<ChevronDown />}
        onClick={() => setMenuOpen((v) => !v)}
        className="px-1.5 py-1 tabular-nums"
      >
        {`${Math.round(camera.scale * 100)}%`}
      </GhostButton>
      <IconButton
        size="sm"
        data-testid="design-canvas-zoom-fit"
        aria-label={t.design.zoomFit}
        title={t.design.zoomFit}
        icon={<Maximize />}
        onClick={onFit}
      />
      {menuOpen && (
        <div
          data-testid="design-canvas-zoom-menu"
          className="absolute bottom-full right-0 mb-1 flex w-28 flex-col gap-0.5 rounded-lg border border-white/[0.1] bg-zinc-900/95 p-1 shadow-xl"
        >
          {ZOOM_PRESETS.map((p) => (
            <GhostButton
              key={p}
              size="sm"
              data-testid={`design-canvas-zoom-preset-${p}`}
              onClick={() => applyPreset(p)}
              className="w-full justify-start px-2 py-1 tabular-nums"
            >
              {`${p}%`}
            </GhostButton>
          ))}
          <input
            data-testid="design-canvas-zoom-input"
            type="number"
            min={10}
            max={500}
            value={draft}
            aria-label={t.design.zoomCustom}
            placeholder={t.design.zoomCustom}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyDraft();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft('');
                setMenuOpen(false);
              }
            }}
            className="mt-0.5 w-full rounded-md border border-white/[0.1] bg-transparent px-2 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-white/25"
          />
        </div>
      )}
    </div>
  );
};
