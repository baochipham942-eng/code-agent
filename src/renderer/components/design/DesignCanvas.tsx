// 设计画布（Cowart 式无限画布，konva/react-konva）。
// P0：平移（拖拽）+ 缩放（滚轮，绕指针）+ 图片节点渲染 + 空状态。
// 圈选标注→inpaint 迭代在 P2 叠加；图片回灌在 P1。相机/节点取自 designCanvasStore。
// 文案走 i18n（t.design.*），不硬编码。
import React, { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage } from 'react-konva';
import type Konva from 'konva';
import { Palette } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useDesignCanvasStore } from './designCanvasStore';
import { readWorkspaceImageAsDataUrl } from './designFiles';
import type { CanvasImageNode } from './designCanvasTypes';

// 缩放范围与步进（避免画布塌缩/无限放大）。
const SCALE_MIN = 0.1;
const SCALE_MAX = 5;
const SCALE_STEP = 1.05;

/**
 * 加载节点图片为 HTMLImageElement；未就绪返回 null。
 * src 为 dataURL / http(s) 时直接用；否则视为相对 run 目录的路径，经 IPC 读成 dataURL
 * （renderer 无法直接读 fs 路径，画布存档也只存相对路径以免膨胀）。
 */
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

const CanvasImage: React.FC<{ node: CanvasImageNode; runDir: string | null }> = ({ node, runDir }) => {
  const img = useNodeImage(runDir, node.src);
  if (!img) return null;
  return (
    <KonvaImage
      image={img}
      x={node.x}
      y={node.y}
      width={node.width}
      height={node.height}
      listening={false}
    />
  );
};

export const DesignCanvas: React.FC = () => {
  const { t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const nodes = useDesignCanvasStore((s) => s.nodes);
  const camera = useDesignCanvasStore((s) => s.camera);
  const setCamera = useDesignCanvasStore((s) => s.setCamera);
  const runDir = useDesignCanvasStore((s) => s.runDir);

  // 容器尺寸跟随（Stage 需要显式像素宽高）。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 滚轮缩放：绕指针位置缩放。
  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>): void => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const oldScale = camera.scale;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const mousePoint = {
      x: (pointer.x - camera.x) / oldScale,
      y: (pointer.y - camera.y) / oldScale,
    };
    const direction = e.evt.deltaY > 0 ? 1 : -1;
    let newScale = direction > 0 ? oldScale / SCALE_STEP : oldScale * SCALE_STEP;
    newScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, newScale));
    setCamera({
      scale: newScale,
      x: pointer.x - mousePoint.x * newScale,
      y: pointer.y - mousePoint.y * newScale,
    });
  };

  // 平移：拖拽 Stage 结束时落库。
  const handleDragEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
    if (e.target !== stageRef.current) return;
    setCamera({ ...camera, x: e.target.x(), y: e.target.y() });
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-zinc-900" data-testid="design-canvas">
      {size.w > 0 && size.h > 0 && (
        <Stage
          ref={stageRef}
          width={size.w}
          height={size.h}
          x={camera.x}
          y={camera.y}
          scaleX={camera.scale}
          scaleY={camera.scale}
          draggable
          onWheel={handleWheel}
          onDragEnd={handleDragEnd}
        >
          <Layer>
            {nodes.map((node) => (
              <CanvasImage key={node.id} node={node} runDir={runDir} />
            ))}
          </Layer>
        </Stage>
      )}
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-500">
          <Palette className="h-6 w-6 text-zinc-600" />
          <span>{t.design.canvasEmpty}</span>
        </div>
      )}
    </div>
  );
};
