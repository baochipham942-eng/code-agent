// 图解层渲染 + 选中/连接交互（konva/react-konva）：连线(connector) + freeform 形状(shape)。
// 与 AnnotationLayer 平级挂 <Stage>，但职责不同：标注层是临时红标注（喂 mask/重绘），
// 本层是可落盘的图解脚手架。
//
// 分工：**绘制**走 Stage 级处理器（DesignCanvas.handleMouseDown/Move/Up，对所有点击都触发，
// 能在节点之上起笔）；本层只负责 ① 渲染连线/形状/draft ② select 模式下选中已有对象（点击
// target 到具体 shape，冒泡正常）③ connect 模式下节点 hit-rect 命中。
import React, { useMemo, useState } from 'react';
import { Layer, Group, Line, Arrow, Rect as KonvaRect, Ellipse as KonvaEllipse, Text as KonvaText } from 'react-konva';
import type { CanvasNode } from './designCanvasTypes';
import type { CanvasConnector, CanvasShape } from './designDiagramTypes';
import type { ShapeTool } from './diagramReducer';
import { connectorEndpoints, connectorMidpoint, type Box } from './connectorGeometry';
import type { SelectedDiagram } from './designCanvasStore';

/** 画布图解工具：select=选择/移动，connect=连线，其余=画形状。 */
export type DiagramCanvasTool = 'select' | 'connect' | ShapeTool;

/** 选中描边色（konva 字面色，ds-allow:viz）。 */
const SELECT_STROKE = '#38bdf8'; // ds-allow:viz sky-400
const CONNECTOR_STROKE = '#94a3b8'; // ds-allow:viz slate-400

interface DiagramLayerProps {
  tool: DiagramCanvasTool;
  /** 可见节点（连线锚点几何 + connect 命中用）。 */
  nodes: CanvasNode[];
  connectors: CanvasConnector[];
  shapes: CanvasShape[];
  /** 进行中的绘制形状（由 Stage 处理器维护），渲染但不可交互。 */
  draft: CanvasShape | null;
  selected: SelectedDiagram;
  onUpdateShape: (id: string, patch: Partial<CanvasShape>) => void;
  onAddConnector: (fromNodeId: string, toNodeId: string) => void;
  onSelect: (sel: SelectedDiagram) => void;
  /** 请求在世界坐标处编辑文字（双击 text·sticky·连线 label）。 */
  onRequestText: (target: TextEditTarget) => void;
}

/** 文字编辑目标：新建 text / 编辑既有形状文字 / 编辑连线 label。 */
export type TextEditTarget =
  | { kind: 'new-text'; world: { x: number; y: number } }
  | { kind: 'shape'; id: string; world: { x: number; y: number }; initial: string }
  | { kind: 'connector'; id: string; world: { x: number; y: number }; initial: string };

function boxOf(n: CanvasNode): Box {
  return { x: n.x, y: n.y, width: n.width, height: n.height };
}

export const DiagramLayer: React.FC<DiagramLayerProps> = ({
  tool,
  nodes,
  connectors,
  shapes,
  draft,
  selected,
  onUpdateShape,
  onAddConnector,
  onSelect,
  onRequestText,
}) => {
  // connect 模式：已点的源节点 id（再点目标即成线）。
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const interactive = tool === 'select';

  const handleNodeClick = (nodeId: string): void => {
    if (connectFrom === null) {
      setConnectFrom(nodeId);
      return;
    }
    if (connectFrom !== nodeId) onAddConnector(connectFrom, nodeId);
    setConnectFrom(null);
  };

  const renderShape = (s: CanvasShape, isDraft: boolean): React.ReactNode => {
    const sel = !isDraft && selected?.type === 'shape' && selected.id === s.id;
    const stroke = sel ? SELECT_STROKE : s.color;
    const handlers = isDraft
      ? { listening: false as const }
      : {
          listening: interactive,
          draggable: interactive,
          onClick: () => onSelect({ type: 'shape', id: s.id }),
          onTap: () => onSelect({ type: 'shape', id: s.id }),
          onDblClick:
            s.kind === 'text' || s.kind === 'sticky'
              ? () =>
                  onRequestText({
                    kind: 'shape',
                    id: s.id,
                    world: { x: s.x, y: s.y },
                    initial: s.text,
                  })
              : undefined,
        };
    switch (s.kind) {
      case 'rect':
        return (
          <KonvaRect
            key={s.id}
            {...handlers}
            x={s.x}
            y={s.y}
            width={s.width}
            height={s.height}
            stroke={stroke}
            strokeWidth={2}
            onDragEnd={(e) => onUpdateShape(s.id, { x: e.target.x(), y: e.target.y() } as Partial<CanvasShape>)}
          />
        );
      case 'ellipse':
        return (
          <KonvaEllipse
            key={s.id}
            {...handlers}
            x={s.x + s.width / 2}
            y={s.y + s.height / 2}
            radiusX={Math.abs(s.width) / 2}
            radiusY={Math.abs(s.height) / 2}
            stroke={stroke}
            strokeWidth={2}
            onDragEnd={(e) =>
              onUpdateShape(s.id, {
                x: e.target.x() - s.width / 2,
                y: e.target.y() - s.height / 2,
              } as Partial<CanvasShape>)
            }
          />
        );
      case 'sticky':
        return (
          <Group
            key={s.id}
            {...handlers}
            x={s.x}
            y={s.y}
            onDragEnd={(e) => onUpdateShape(s.id, { x: e.target.x(), y: e.target.y() } as Partial<CanvasShape>)}
          >
            <KonvaRect
              width={s.width}
              height={s.height}
              fill="rgba(250,204,21,0.12)"
              stroke={stroke}
              strokeWidth={2}
              cornerRadius={4}
            />
            <KonvaText text={s.text} x={6} y={6} width={Math.max(0, s.width - 12)} fontSize={14} fill={s.color} />
          </Group>
        );
      case 'text':
        return (
          <KonvaText
            key={s.id}
            {...handlers}
            x={s.x}
            y={s.y}
            text={s.text || ' '}
            fontSize={18}
            fill={stroke}
            onDragEnd={(e) => onUpdateShape(s.id, { x: e.target.x(), y: e.target.y() } as Partial<CanvasShape>)}
          />
        );
      case 'line':
        return (
          <Line
            key={s.id}
            {...handlers}
            points={s.points}
            stroke={stroke}
            strokeWidth={2}
            hitStrokeWidth={12}
            onDragEnd={(e) => {
              const dx = e.target.x();
              const dy = e.target.y();
              e.target.position({ x: 0, y: 0 });
              onUpdateShape(s.id, {
                points: [s.points[0] + dx, s.points[1] + dy, s.points[2] + dx, s.points[3] + dy],
              } as Partial<CanvasShape>);
            }}
          />
        );
      default:
        return null;
    }
  };

  return (
    <Layer>
      {/* 连线（按两端节点实时锚点）。 */}
      {connectors.map((c) => {
        const from = nodeById.get(c.fromNodeId);
        const to = nodeById.get(c.toNodeId);
        if (!from || !to) return null; // 悬空保护（端点节点不可见/已删）
        const e = connectorEndpoints(boxOf(from), boxOf(to));
        const sel = selected?.type === 'connector' && selected.id === c.id;
        const stroke = sel ? SELECT_STROKE : CONNECTOR_STROKE;
        const mid = connectorMidpoint(e);
        return (
          <Group key={c.id}>
            <Arrow
              points={[e.x1, e.y1, e.x2, e.y2]}
              stroke={stroke}
              fill={stroke}
              strokeWidth={2}
              pointerLength={9}
              pointerWidth={9}
              hitStrokeWidth={14}
              listening={interactive}
              onClick={() => onSelect({ type: 'connector', id: c.id })}
              onTap={() => onSelect({ type: 'connector', id: c.id })}
              onDblClick={() => onRequestText({ kind: 'connector', id: c.id, world: mid, initial: c.label ?? '' })}
            />
            {c.label ? (
              <KonvaText text={c.label} x={mid.x} y={mid.y - 8} fontSize={13} fill={stroke} listening={false} />
            ) : null}
          </Group>
        );
      })}

      {/* 形状（已落定 + 进行中 draft）。 */}
      {shapes.map((s) => renderShape(s, false))}
      {draft ? renderShape(draft, true) : null}

      {/* connect 模式：每个节点盖透明 hit-rect 捕获点击（源高亮）。 */}
      {tool === 'connect' &&
        nodes.map((n) => (
          <KonvaRect
            key={`hit-${n.id}`}
            x={n.x}
            y={n.y}
            width={n.width}
            height={n.height}
            fill="rgba(56,189,248,0.001)"
            stroke={connectFrom === n.id ? SELECT_STROKE : undefined}
            strokeWidth={connectFrom === n.id ? 3 : 0}
            onClick={() => handleNodeClick(n.id)}
            onTap={() => handleNodeClick(n.id)}
          />
        ))}
    </Layer>
  );
};
