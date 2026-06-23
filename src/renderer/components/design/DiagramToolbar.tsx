// 图解工具条：模式切换（选择/连线/矩形/椭圆/线/文字/便签）+ 调色板 + 删除选中。
// 配置/管理类不属此处——这是消费 surface，只放工具选择（feedback_neo_config_in_settings_ia）。
import React from 'react';
import { MousePointer2, Spline, Square, Circle, Minus, Type, StickyNote, Trash2 } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { DIAGRAM_PALETTE } from './designDiagramTypes';
import type { DiagramCanvasTool } from './DiagramLayer';

interface DiagramToolbarProps {
  tool: DiagramCanvasTool;
  onToolChange: (t: DiagramCanvasTool) => void;
  color: string;
  onColorChange: (c: string) => void;
  /** 有选中图解对象时显示删除按钮。 */
  canDelete: boolean;
  onDelete: () => void;
}

export const DiagramToolbar: React.FC<DiagramToolbarProps> = ({
  tool,
  onToolChange,
  color,
  onColorChange,
  canDelete,
  onDelete,
}) => {
  const { t } = useI18n();
  const tools: { id: DiagramCanvasTool; icon: React.ReactNode; label: string }[] = [
    { id: 'select', icon: <MousePointer2 className="h-4 w-4" />, label: t.design.diagramSelect },
    { id: 'connect', icon: <Spline className="h-4 w-4" />, label: t.design.diagramConnect },
    { id: 'rect', icon: <Square className="h-4 w-4" />, label: t.design.diagramRect },
    { id: 'ellipse', icon: <Circle className="h-4 w-4" />, label: t.design.diagramEllipse },
    { id: 'line', icon: <Minus className="h-4 w-4" />, label: t.design.diagramLine },
    { id: 'text', icon: <Type className="h-4 w-4" />, label: t.design.diagramText },
    { id: 'sticky', icon: <StickyNote className="h-4 w-4" />, label: t.design.diagramSticky },
  ];
  return (
    <div
      data-testid="diagram-toolbar"
      className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/[0.1] bg-zinc-900/90 px-2 py-1.5 shadow-xl backdrop-blur"
    >
      {tools.map((it) => (
        <button
          key={it.id}
          type="button"
          title={it.label}
          aria-label={it.label}
          aria-pressed={tool === it.id}
          data-tool={it.id}
          onClick={() => onToolChange(it.id)}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
            tool === it.id ? 'bg-sky-500/25 text-sky-200' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
          }`}
        >
          {it.icon}
        </button>
      ))}
      <div className="mx-1 h-5 w-px bg-white/[0.1]" />
      {/* 调色板（图解形状描边色）。 */}
      <div className="flex items-center gap-1" role="group" aria-label={t.design.diagramColor}>
        {DIAGRAM_PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            data-color={c}
            onClick={() => onColorChange(c)}
            className={`h-4 w-4 rounded-full border transition-transform ${
              color === c ? 'scale-110 border-white' : 'border-white/30 hover:scale-105'
            }`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      {canDelete && (
        <>
          <div className="mx-1 h-5 w-px bg-white/[0.1]" />
          <button
            type="button"
            title={t.design.diagramDelete}
            aria-label={t.design.diagramDelete}
            data-testid="diagram-delete"
            onClick={onDelete}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-red-500/20 hover:text-red-200"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
};
