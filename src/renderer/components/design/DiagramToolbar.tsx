// 图解工具条：模式切换（选择/连线/矩形/椭圆/线/文字/便签）+ 调色板 + 删除选中。
// 未选中态这条就是「画布级工具条」——作用对象是整块画布的动作（导出 PPTX）也放这里
// （2026-08-01 工单②：原先游离在右上角，跟工具条分离成两块）。
// 配置/管理类不属此处——这是消费 surface，只放工具选择（feedback_neo_config_in_settings_ia）。
// K1 溢出折叠（2026-08-01）：7 个工具图标始终平铺；实测宽度放不下时调色板收成「当前色」
// 小圆点（点开才展开五色）、「导出 PPTX」收进「⋯」菜单；宽栏下调色板仍展开平铺，宽度回来双向铺回。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MousePointer2, Spline, Square, Circle, Minus, Type, StickyNote, Trash2, Loader2, MoreHorizontal, Presentation } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { DIAGRAM_PALETTE } from './designDiagramTypes';
import type { DiagramCanvasTool } from './DiagramLayer';
import { useToolbarOverflow } from './useToolbarOverflow';

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

// 参与溢出收折的项：tools 永不收（首位兜底，7 个图标不占地方）；放不下时先收 export 再收 palette。
type DiagramOverflowId = 'tools' | 'palette' | 'export';

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
  const rootRef = useRef<HTMLDivElement>(null);
  const deleteSegmentRef = useRef<HTMLDivElement>(null);
  const [openMenu, setOpenMenu] = useState<'palette' | 'more' | null>(null);

  const hasExport = Boolean(exportPptx);
  const itemIds = useMemo<readonly DiagramOverflowId[]>(
    () => (hasExport ? ['tools', 'palette', 'export'] : ['tools', 'palette']),
    [hasExport],
  );
  // 内条 px-2 + border ≈ 18px 不可压缩；收折入口（当前色圆点 28 + ⋯ 28 + 间距）预留 72px。
  const { overflowed, itemRef } = useToolbarOverflow<DiagramOverflowId>({
    containerRef: rootRef,
    itemIds,
    reserveWidth: 72,
    fixedRef: deleteSegmentRef,
    fixedElementCount: canDelete ? 1 : 0,
    gap: 4,
    chromeWidth: 18,
  });
  const paletteCollapsed = overflowed.has('palette');
  const exportCollapsed = overflowed.has('export');

  // 外点关菜单（document 级监听，不铺全屏背板，避免 handrolled-modal 门）。
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  const tools: { id: DiagramCanvasTool; icon: React.ReactNode; label: string }[] = [
    { id: 'select', icon: <MousePointer2 className="h-4 w-4" />, label: t.design.diagramSelect },
    { id: 'connect', icon: <Spline className="h-4 w-4" />, label: t.design.diagramConnect },
    { id: 'rect', icon: <Square className="h-4 w-4" />, label: t.design.diagramRect },
    { id: 'ellipse', icon: <Circle className="h-4 w-4" />, label: t.design.diagramEllipse },
    { id: 'line', icon: <Minus className="h-4 w-4" />, label: t.design.diagramLine },
    { id: 'text', icon: <Type className="h-4 w-4" />, label: t.design.diagramText },
    { id: 'sticky', icon: <StickyNote className="h-4 w-4" />, label: t.design.diagramSticky },
  ];

  // 五色 swatch 平铺态与圆点浮层共用同一份 JSX。
  const swatches = DIAGRAM_PALETTE.map((c) => (
    <button
      key={c}
      type="button"
      aria-label={c}
      data-color={c}
      onClick={() => {
        onColorChange(c);
        setOpenMenu(null);
      }}
      className={`h-4 w-4 shrink-0 rounded-full border transition-transform ${
        color === c ? 'scale-110 border-white' : 'border-white/30 hover:scale-105'
      }`}
      style={{ backgroundColor: c }}
    />
  ));

  return (
    // 外条满宽不收货（2026-08-01 返工 f1）：absolute left-1/2 的 shrink-to-fit 可用宽只有容器一半，
    // 700px 栏下 7 工具+调色板（一排约 350px）必换行成二排，第二排把左上的未选中引导提示盖住。
    // 外条 left-2 right-2 满宽 + 内条居中 shrink-to-fit（同 fc3c958 图像动词条修法）。
    // K1：内条不再 flex-wrap——放不下的由 useToolbarOverflow 实测后收折，任何宽度下只有一排。
    // z-20（原 z-10 → K1 改）：调色板圆点浮层/⋯ 菜单要压过同为 z-10 但 DOM 序更靠后的
    // 边栏面板（验收实测：浮层被面板压住点不到，同图像动词条 fc3c958 的修法）。
    <div ref={rootRef} className="pointer-events-none absolute left-2 right-2 top-4 z-20 flex justify-center">
      {/* whitespace-nowrap + 各段 shrink-0：不许 flex 收缩/文字换行——否则溢出 hook 量到的
          是被挤压后的宽度，永远误判「放得下」（2026-08-01 验收实测翻车，同图像动词条）。 */}
      <div
        data-testid="diagram-toolbar"
        className="pointer-events-auto flex max-w-full items-center justify-center gap-1 whitespace-nowrap rounded-xl border border-white/[0.1] bg-zinc-900/90 px-2 py-1.5 shadow-xl backdrop-blur"
      >
      <div ref={itemRef('tools')} className="flex shrink-0 items-center gap-1">
        <div className="flex shrink-0 items-center gap-1">
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
              tool === it.id ? 'bg-sky-500/25 text-badge-info' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
            }`}
          >
            {it.icon}
          </button>
          ))}
        </div>
        <div className="mx-1 h-5 w-px shrink-0 bg-white/[0.1]" />
      </div>
      {/* 调色板（图解形状描边色）：宽栏平铺五色；窄栏收成「当前色」小圆点，点开浮层选色。 */}
      {!paletteCollapsed ? (
        <div ref={itemRef('palette')} className="flex shrink-0 items-center gap-1" role="group" aria-label={t.design.diagramColor}>
          {swatches}
        </div>
      ) : (
        <div className="relative shrink-0">
          {/* ds-allow:start 调色板收折态「当前色」圆点按钮沿用工具键裸 button 风格，与相邻工具键一致；design-mode W3 收口时统一迁 primitive */}
          <button
            type="button"
            title={t.design.diagramColor}
            aria-label={t.design.diagramColor}
            aria-expanded={openMenu === 'palette'}
            data-testid="diagram-palette-dot"
            onClick={() => setOpenMenu((cur) => (cur === 'palette' ? null : 'palette'))}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
          >
            <span className="block h-3.5 w-3.5 rounded-full border border-white/40" style={{ backgroundColor: color }} />
          </button>
          {/* ds-allow:end */}
          {openMenu === 'palette' && (
            <div
              data-testid="diagram-palette-popover"
              role="group"
              aria-label={t.design.diagramColor}
              // right-0 向左展开（2026-08-02 收口工单）：调色板恰恰只在宽度紧张时才收成圆点，
              // left-0 朝紧张那一侧（右）展开，第 5 个色块必被窗口右缘裁掉——两个条件永远同时成立。
              // 调色板在工具条中段，向左展开必然落在工具条自身宽度内；同文件 ⋯ 菜单也是 right-0。
              className="absolute right-0 top-full z-20 mt-2 flex gap-1 rounded-xl border border-white/[0.1] bg-zinc-900/95 p-2 shadow-xl backdrop-blur"
            >
              {swatches}
            </div>
          )}
        </div>
      )}
      {canDelete && (
        <div ref={deleteSegmentRef} className="flex shrink-0 items-center gap-1">
          <div className="mx-1 h-5 w-px shrink-0 bg-white/[0.1]" />
          <button
            type="button"
            title={t.design.diagramDelete}
            aria-label={t.design.diagramDelete}
            data-testid="diagram-delete"
            onClick={onDelete}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-red-500/20 hover:text-badge-danger"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
      {exportPptx && !exportCollapsed && (
        <div ref={itemRef('export')} className="flex shrink-0 items-center gap-1">
          <div className="mx-1 h-5 w-px shrink-0 bg-white/[0.1]" />
          <div className="shrink-0">
            {/* ds-allow:start 画布级导出按钮沿用工具条裸 button 风格，与相邻工具键一致；design-mode 整体 W3 收口时统一迁 primitive */}
            <button
              type="button"
              data-testid="design-canvas-export-pptx"
              onClick={exportPptx.onExport}
              disabled={exportPptx.exporting}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-50"
            >
              {exportPptx.exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Presentation className="h-3.5 w-3.5" />
              )}
              {t.design.exportCanvasPptx}
            </button>
            {/* ds-allow:end */}
          </div>
        </div>
      )}
      {exportPptx && exportCollapsed && (
        <>
          <div className="mx-1 h-5 w-px shrink-0 bg-white/[0.1]" />
          <div className="relative shrink-0">
            {/* ds-allow:start 溢出 ⋯ 触发按钮沿用工具键裸 button 风格（h-7 w-7 图标键），与相邻工具键一致；design-mode W3 收口时统一迁 primitive */}
            <button
              type="button"
              title={t.design.imageToolbarMore}
              aria-label={t.design.imageToolbarMore}
              aria-expanded={openMenu === 'more'}
              data-testid="diagram-toolbar-more"
              onClick={() => setOpenMenu((cur) => (cur === 'more' ? null : 'more'))}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {/* ds-allow:end */}
            {openMenu === 'more' && (
              <div
                data-testid="diagram-more-menu"
                className="absolute right-0 top-full z-20 mt-2 w-48 rounded-xl border border-white/[0.1] bg-zinc-900/95 p-1 shadow-xl backdrop-blur"
              >
                {/* ds-allow:start 溢出菜单项为图标+文字菜单行（hover 态自定义，非 Button variant），与图像动词条「更多」菜单行一致 */}
                <button
                  type="button"
                  data-testid="diagram-more-export-pptx"
                  onClick={() => {
                    setOpenMenu(null);
                    exportPptx.onExport();
                  }}
                  disabled={exportPptx.exporting}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-50"
                >
                  {exportPptx.exporting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                  ) : (
                    <Presentation className="h-3.5 w-3.5 text-zinc-500" />
                  )}
                  {t.design.exportCanvasPptx}
                </button>
                {/* ds-allow:end */}
              </div>
            )}
          </div>
        </>
      )}
      </div>
    </div>
  );
};
