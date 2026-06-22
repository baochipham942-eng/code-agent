// 红色标注层（konva/react-konva）：自由笔 / 箭头 / 矩形 / 文字四种工具。
// 核心逻辑是纯归约器 reduceAnnot —— 把指针事件序列归约成 shapes 数组，
// 不依赖 konva，可单测（见 tests/renderer/design/annotationLayer.test.tsx）。
// 渲染组件遵循 DesignCanvas.tsx 的 react-konva 用法。
import React, { useRef } from 'react';
import { Layer, Line, Arrow, Rect as KonvaRect, Text as KonvaText } from 'react-konva';
import type Konva from 'konva';

export type AnnotTool = 'pen' | 'arrow' | 'rect' | 'text';

export type AnnotShape =
  | { kind: 'pen'; points: number[]; color: string }
  | { kind: 'arrow'; points: [number, number, number, number]; color: string }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'text'; x: number; y: number; text: string; color: string };

// 标注统一用红色（不在本常量外硬编码颜色）。
export const ANNOT_COLOR = '#ef4444'; // ds-allow:viz konva 画布字面色，CSS 变量够不到

export type AnnotEvent =
  | { type: 'down'; tool: AnnotTool; x: number; y: number; text?: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'up' };

/**
 * 纯归约器：把单个指针事件归约进 shapes 数组。
 * - down 起笔（pen/arrow/rect 推一个"进行中"shape；text 立即落定）
 * - move 更新最后一个"进行中"shape（替换末尾，不原地改）
 * - up 落定（no-op，仅返回当前 shapes）
 * 不可变：永远返回新数组，不修改入参。
 */
export function reduceAnnot(shapes: AnnotShape[], evt: AnnotEvent): AnnotShape[] {
  switch (evt.type) {
    case 'down': {
      switch (evt.tool) {
        case 'pen':
          return [...shapes, { kind: 'pen', points: [evt.x, evt.y], color: ANNOT_COLOR }];
        case 'arrow':
          // 起点先填进两端，move 时更新终点。
          return [
            ...shapes,
            { kind: 'arrow', points: [evt.x, evt.y, evt.x, evt.y], color: ANNOT_COLOR },
          ];
        case 'rect':
          // 记下起点角，宽高初始为 0，move 时计算。
          return [...shapes, { kind: 'rect', x: evt.x, y: evt.y, w: 0, h: 0, color: ANNOT_COLOR }];
        case 'text':
          return [
            ...shapes,
            { kind: 'text', x: evt.x, y: evt.y, text: evt.text ?? '', color: ANNOT_COLOR },
          ];
        default:
          return shapes;
      }
    }
    case 'move': {
      if (shapes.length === 0) return shapes;
      const last = shapes[shapes.length - 1];
      const head = shapes.slice(0, -1);
      switch (last.kind) {
        case 'pen':
          // 追加点位（pen 起点保留，沿途累积）。
          return [...head, { ...last, points: [...last.points, evt.x, evt.y] }];
        case 'arrow':
          // 终点 = 当前坐标，起点取已记录的前两位。
          return [
            ...head,
            { ...last, points: [last.points[0], last.points[1], evt.x, evt.y] },
          ];
        case 'rect':
          // 宽高 = 当前坐标 - 起点角（支持反向，可为负）。
          return [...head, { ...last, w: evt.x - last.x, h: evt.y - last.y }];
        case 'text':
          // text 已落定，move 不更新。
          return shapes;
        default:
          return shapes;
      }
    }
    case 'up':
      // 落定即可，进行中 shape 已在数组里。
      return shapes;
    default:
      return shapes;
  }
}

interface AnnotationLayerProps {
  shapes: AnnotShape[];
  onShapesChange: (s: AnnotShape[]) => void;
  tool: AnnotTool;
}

/**
 * 标注渲染层：把 shapes 画成红色 konva 图元，并把 Stage 指针事件
 * 经 reduceAnnot 归约后回传。挂在 DesignCanvas 的 <Stage> 内、与图层平级。
 */
export const AnnotationLayer: React.FC<AnnotationLayerProps> = ({ shapes, onShapesChange, tool }) => {
  // 是否正在拖拽进行中（pen/arrow/rect 需要 down→move→up）。
  const drawing = useRef(false);

  // 从 Stage 取当前世界坐标（与 DesignCanvas 的相机变换一致）。
  const worldPoint = (e: Konva.KonvaEventObject<MouseEvent>): { x: number; y: number } | null => {
    const stage = e.target.getStage();
    const p = stage?.getRelativePointerPosition();
    if (!p) return null;
    return { x: p.x, y: p.y };
  };

  const handleDown = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    const w = worldPoint(e);
    if (!w) return;
    if (tool === 'text') {
      // 文字工具：弹出输入，非空才落定。
      const text = typeof window !== 'undefined' ? window.prompt('标注文字') ?? '' : '';
      if (!text.trim()) return;
      onShapesChange(reduceAnnot(shapes, { type: 'down', tool, x: w.x, y: w.y, text }));
      return;
    }
    drawing.current = true;
    onShapesChange(reduceAnnot(shapes, { type: 'down', tool, x: w.x, y: w.y }));
  };

  const handleMove = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    if (!drawing.current) return;
    const w = worldPoint(e);
    if (!w) return;
    onShapesChange(reduceAnnot(shapes, { type: 'move', x: w.x, y: w.y }));
  };

  const handleUp = (): void => {
    if (!drawing.current) return;
    drawing.current = false;
    onShapesChange(reduceAnnot(shapes, { type: 'up' }));
  };

  return (
    <Layer onMouseDown={handleDown} onMouseMove={handleMove} onMouseUp={handleUp}>
      {shapes.map((shape, i) => {
        switch (shape.kind) {
          case 'pen':
            return (
              <Line
                key={i}
                points={shape.points}
                stroke={shape.color}
                strokeWidth={3}
                lineCap="round"
                lineJoin="round"
                tension={0.2}
                listening={false}
              />
            );
          case 'arrow':
            return (
              <Arrow
                key={i}
                points={shape.points}
                stroke={shape.color}
                fill={shape.color}
                strokeWidth={3}
                pointerLength={10}
                pointerWidth={10}
                listening={false}
              />
            );
          case 'rect':
            return (
              <KonvaRect
                key={i}
                x={shape.x}
                y={shape.y}
                width={shape.w}
                height={shape.h}
                stroke={shape.color}
                strokeWidth={2}
                listening={false}
              />
            );
          case 'text':
            return (
              <KonvaText
                key={i}
                x={shape.x}
                y={shape.y}
                text={shape.text}
                fontSize={18}
                fill={shape.color}
                listening={false}
              />
            );
          default:
            return null;
        }
      })}
    </Layer>
  );
};
