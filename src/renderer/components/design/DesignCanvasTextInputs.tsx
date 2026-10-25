// 设计画布的两个画布内文字输入框（从 DesignCanvas 抽出，纯展示组件，无逻辑改动）：
// - DiagramTextInput：图解文字内联编辑（新建 text / 改形状文字 / 改连线 label）
// - AnnotTextDraftInput：文字标注草稿输入（画布内，替代原生 window.prompt）
import React from 'react';
import { reduceAnnot, type AnnotShape } from './AnnotationLayer';
import type { TextEditTarget } from './DiagramLayer';
import type { CanvasCamera } from './designCanvasTypes';

// 图解文字内联编辑（新建 text / 改形状文字 / 改连线 label）。
export const DiagramTextInput: React.FC<{
  text: { target: TextEditTarget; value: string };
  camera: CanvasCamera;
  placeholder: string;
  onValueChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}> = ({ text, camera, placeholder, onValueChange, onCommit, onCancel }) => {
  const sx = text.target.world.x * camera.scale + camera.x;
  const sy = text.target.world.y * camera.scale + camera.y;
  return (
    <input
      autoFocus
      data-testid="diagram-text-input"
      value={text.value}
      onChange={(e) => onValueChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCommit}
      placeholder={placeholder}
      className="absolute z-10 rounded border border-badge-info/60 bg-zinc-900/95 px-1.5 py-0.5 text-xs text-zinc-100 shadow-lg outline-none placeholder:text-zinc-500"
      style={{ left: sx, top: sy, minWidth: 120 }}
    />
  );
};

// 文字标注输入框（画布内，替代原生 window.prompt；落点处定位，Enter 落定 / Esc 取消）。
export const AnnotTextDraftInput: React.FC<{
  draft: { world: { x: number; y: number }; value: string };
  camera: CanvasCamera;
  shapes: AnnotShape[];
  placeholder: string;
  onShapesChange: (next: AnnotShape[]) => void;
  onValueChange: (value: string) => void;
  onDismiss: () => void;
}> = ({ draft, camera, shapes, placeholder, onShapesChange, onValueChange, onDismiss }) => {
  const sx = draft.world.x * camera.scale + camera.x;
  const sy = draft.world.y * camera.scale + camera.y;
  const commit = (): void => {
    const text = draft.value.trim();
    if (text) {
      onShapesChange(
        reduceAnnot(shapes, {
          type: 'down',
          tool: 'text',
          x: draft.world.x,
          y: draft.world.y,
          text,
        }),
      );
    }
    onDismiss();
  };
  return (
    <input
      autoFocus
      value={draft.value}
      onChange={(e) => onValueChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onDismiss();
        }
      }}
      onBlur={commit}
      placeholder={placeholder}
      // ds-allow:viz 标注输入框用红色描边呼应标注色，绝对定位于画布落点
      className="absolute z-10 rounded border border-badge-danger/60 bg-zinc-900/95 px-1.5 py-0.5 text-xs text-badge-danger shadow-lg outline-none placeholder:text-zinc-500"
      style={{ left: sx, top: sy, minWidth: 120 }}
    />
  );
};
