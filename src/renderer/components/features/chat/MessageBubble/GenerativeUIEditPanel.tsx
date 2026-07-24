// ============================================================================
// GenerativeUIEditPanel - 选中元素的属性面板：文字 / 字号 / 颜色
// ============================================================================
// 只做飞书演示的那三项。字体族、粗细、对齐、间距、增删元素一律不做——
// 再往下加就是在做网页编辑器，不是「改个错别字改个颜色」。

import { memo, useCallback, useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { isTextEditable, SANDBOX_TEXT_COLOR, type HtmlElementEdit } from './generativeUIDocument';

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 72;
const FALLBACK_FONT_SIZE = 14;

function toHexColor(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!rgb) return null;
  return `#${[rgb[1], rgb[2], rgb[3]]
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * 读当前值给面板打底。先看内联 style（用户此前改过的就在这儿），再看计算样式；
 * 两者都读不到才退到兜底值——面板显示的数字必须是元素此刻真实的样子。
 */
export function readElementStyle(element: Element): { fontSize: number; color: string } {
  const inline = (element as HTMLElement).style;
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element);

  const fontSizeSource = inline?.fontSize || computed?.fontSize || '';
  const parsedFontSize = Number.parseFloat(fontSizeSource);
  const fontSize = Number.isFinite(parsedFontSize) && parsedFontSize > 0
    ? Math.round(parsedFontSize)
    : FALLBACK_FONT_SIZE;

  const color = toHexColor(inline?.color || computed?.color || '') ?? SANDBOX_TEXT_COLOR;
  return { fontSize, color };
}

export const GenerativeUIEditPanel = memo(function GenerativeUIEditPanel({
  element,
  tag,
  onApply,
  onClear,
}: {
  element: Element;
  tag: string;
  onApply: (edit: Omit<HtmlElementEdit, 'selector'>) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const editable = isTextEditable(element);
  // 初值只读一次，靠外层 key={selector} 换元素时重建——用 effect 回灌会在
  // 输入过程中把正在编辑的内容冲掉。
  const [initial] = useState(() => readElementStyle(element));
  const [text, setText] = useState(() => (editable ? element.textContent ?? '' : ''));
  const [fontSize, setFontSize] = useState(initial.fontSize);
  const [color, setColor] = useState(initial.color);

  const handleText = useCallback((next: string) => {
    setText(next);
    onApply({ text: next });
  }, [onApply]);

  const handleFontSize = useCallback((next: number) => {
    const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, next));
    setFontSize(clamped);
    onApply({ fontSize: clamped });
  }, [onApply]);

  const handleColor = useCallback((next: string) => {
    setColor(next);
    onApply({ color: next });
  }, [onApply]);

  return (
    <div
      className="border-t border-zinc-700 bg-zinc-950/60 px-4 py-2.5"
      data-testid="generative-ui-selection-bar"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] text-cyan-200">
          {`<${tag}>`}
        </span>
        <div className="min-w-0 flex-1">
          {editable ? (
            <input
              type="text"
              value={text}
              onChange={(event) => handleText(event.target.value)}
              data-testid="generative-ui-text-input"
              aria-label={t.generativeUI.textLabel}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 focus:border-cyan-500/50 focus:outline-none"
            />
          ) : (
            <span className="text-[11px] text-zinc-500">{t.generativeUI.textNotEditable}</span>
          )}
        </div>
        <button
          onClick={onClear}
          className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title={t.generativeUI.clearSelection}
          aria-label={t.generativeUI.clearSelection}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="mt-2 flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          {t.generativeUI.fontSizeLabel}
          <input
            type="number"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            value={fontSize}
            onChange={(event) => handleFontSize(Number(event.target.value))}
            data-testid="generative-ui-font-size-input"
            className="w-14 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100 focus:border-cyan-500/50 focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          {t.generativeUI.colorLabel}
          {/* ds-allow:start 取色器是原生 input[type=color]，设计系统无对应 primitive；
              尺寸压到与相邻数字输入同高，避免撑坏这条工具栏 */}
          <input
            type="color"
            value={color}
            onChange={(event) => handleColor(event.target.value)}
            data-testid="generative-ui-color-input"
            className="h-6 w-8 cursor-pointer rounded border border-zinc-700 bg-zinc-900"
          />
          {/* ds-allow:end */}
        </label>
      </div>
    </div>
  );
});
