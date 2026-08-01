// 图解工具条：模式切换（选择/连线/矩形/椭圆/线/文字/便签）+ 调色板 + 删除选中。
// 未选中态这条就是「画布级工具条」——作用对象是整块画布的动作（导出 PPTX）也放这里
// （2026-08-01 工单②：原先游离在右上角，跟工具条分离成两块）。
// 配置/管理类不属此处——这是消费 surface，只放工具选择（feedback_neo_config_in_settings_ia）。
import React from 'react';
import { MousePointer2, Spline, Square, Circle, Minus, Type, StickyNote, Trash2, Loader2, Presentation } from 'lucide-react';
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
  /** 画布级导出（整块画布 → PPTX）。画布上还没有图（无可导出内容）时不传。 */
  exportPptx?: { exporting: boolean; onExport: () => void };
}

export const DiagramToolbar: React.FC<DiagramToolbarProps> = ({
  tool,
  onToolChange,
  color,
  onColorChange,
  canDelete,
  onDelete,
  exportPptx,
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
    // 外条满宽不收货（2026-08-01 返工 f1）：absolute left-1/2 的 shrink-to-fit 可用宽只有容器一半，
    // 700px 栏下 7 工具+调色板（一排约 350px）必换行成二排，第二排把左上的未选中引导提示盖住。
    // 外条 left-2 right-2 满宽 + 内条居中 shrink-to-fit（同 fc3c958 图像动词条修法）；内条保留
    // flex-wrap + max-w-full，320px 档仍自动二排收纳。
    <div className="pointer-events-none absolute left-2 right-2 top-4 z-10 flex justify-center">
      <div
        data-testid="diagram-toolbar"
        className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-xl border border-white/[0.1] bg-zinc-900/90 px-2 py-1.5 shadow-xl backdrop-blur"
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
      {exportPptx && (
        <>
          <div className="mx-1 h-5 w-px bg-white/[0.1]" />
          {/* ds-allow:start 画布级导出按钮沿用工具条裸 button 风格，与相邻工具键一致；design-mode 整体 W3 收口时统一迁 primitive */}
          <button
            type="button"
            data-testid="design-canvas-export-pptx"
            onClick={exportPptx.onExport}
            disabled={exportPptx.exporting}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-50"
          >
            {exportPptx.exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Presentation className="h-3.5 w-3.5" />
            )}
            {t.design.exportCanvasPptx}
          </button>
          {/* ds-allow:end */}
        </>
      )}
      </div>
    </div>
  );
};
