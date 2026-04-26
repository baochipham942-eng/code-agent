// ============================================================================
// V2-B TweakPanel - 5 类原子操作的可视化 control
// ----------------------------------------------------------------------------
// 选中元素 → 推断当前 axis 值 → 渲染 control → 用户操作 → IPC applyTweak →
// 文件改 → vite HMR → bridge restore-selection 回流 → control 拿到新值。
//
// 全过程 0 LLM token，时延 = HMR 时延（spike-app 实测 < 200ms）。
//
// 范围：仅支持 className 是字面量的元素（StringLiteral / 纯模板字符串）。
// 探测到 className 是表达式时显示「需要走 visual_edit」hint，不渲染 controls。
// ============================================================================

import React, { useCallback, useMemo, useState } from 'react';
import { Sparkles, AlertTriangle } from 'lucide-react';
import { invokeDomain } from '../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import type { LivePreviewSelectedElement } from '../../stores/appStore';
import type {
  ClassMutation,
  ColorTarget,
  SpacingAxis,
  FontSizeKey,
  RadiusKey,
} from '@shared/livePreview/tweak';

interface Props {
  selected: LivePreviewSelectedElement;
  /** 是否折叠面板 */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

// ----------------------------------------------------------------------------
// 静态选项（V2-B 范围内的 Tailwind 默认值）
// ----------------------------------------------------------------------------

const COLOR_FAMILIES = [
  'slate', 'gray', 'zinc', 'red', 'orange', 'amber', 'yellow', 'lime',
  'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet',
  'purple', 'fuchsia', 'pink', 'rose',
];
const COLOR_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
const SPACING_VALUES = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];
const FONT_SIZES: FontSizeKey[] = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'];
const RADIUS_SIZES: RadiusKey[] = ['none', 'sm', '', 'md', 'lg', 'xl', '2xl', '3xl', 'full'];

// ----------------------------------------------------------------------------
// 推断当前值的小 helper（从 className 字符串里挖）
// ----------------------------------------------------------------------------

function findFirstMatch(classes: string[], pattern: RegExp): RegExpMatchArray | null {
  for (const c of classes) {
    const m = c.match(pattern);
    if (m) return m;
  }
  return null;
}

interface InferredState {
  spacing: Partial<Record<SpacingAxis, number | 'px'>>;
  color: { text?: { color: string; shade: number }; bg?: { color: string; shade: number }; border?: { color: string; shade: number } };
  fontSize?: FontSizeKey;
  radius?: RadiusKey;
  textAlign?: string;
  itemsAlign?: string;
  justifyAlign?: string;
}

const SPACING_AXES: SpacingAxis[] = ['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'm', 'mx', 'my', 'gap'];

function inferState(className: string | undefined): InferredState {
  const out: InferredState = { spacing: {}, color: {} };
  if (!className) return out;
  const classes = className.split(/\s+/).filter(Boolean);

  for (const axis of SPACING_AXES) {
    // 关键：长前缀优先（pt 之前不能匹配 p）
    const m = findFirstMatch(classes, new RegExp(`^${axis}-(\\d+(?:\\.\\d+)?|px)$`));
    if (m) {
      out.spacing[axis] = m[1] === 'px' ? 'px' : Number(m[1]);
    }
  }

  for (const target of ['text', 'bg', 'border'] as ColorTarget[]) {
    const m = findFirstMatch(classes, new RegExp(`^${target}-([a-z]+)-(\\d{2,3})$`));
    if (m) (out.color as Record<string, unknown>)[target] = { color: m[1], shade: Number(m[2]) };
  }

  const fs = findFirstMatch(classes, /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)$/);
  if (fs) out.fontSize = fs[1] as FontSizeKey;

  const r = findFirstMatch(classes, /^rounded(?:-(none|sm|md|lg|xl|2xl|3xl|full))?$/);
  if (r) out.radius = (r[1] ?? '') as RadiusKey;

  const ta = findFirstMatch(classes, /^text-(left|center|right|justify|start|end)$/);
  if (ta) out.textAlign = ta[1];
  const ia = findFirstMatch(classes, /^items-(start|end|center|baseline|stretch)$/);
  if (ia) out.itemsAlign = ia[1];
  const ja = findFirstMatch(classes, /^justify-(start|end|center|between|around|evenly)$/);
  if (ja) out.justifyAlign = ja[1];

  return out;
}

// ----------------------------------------------------------------------------
// IPC dispatcher
// ----------------------------------------------------------------------------

interface TweakResultLike {
  ok: boolean;
  reason?: string;
  detail?: string;
  newClassName?: string;
}

async function dispatchTweak(
  selected: LivePreviewSelectedElement,
  mutation: ClassMutation,
): Promise<TweakResultLike> {
  return invokeDomain<TweakResultLike>(IPC_DOMAINS.LIVE_PREVIEW, 'applyTweak', {
    location: { file: selected.file, line: selected.line, column: selected.column },
    mutation,
  });
}

// ----------------------------------------------------------------------------
// 子 control（内联实现，纯展示 + 触发回调）
// ----------------------------------------------------------------------------

const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="space-y-1.5">
    <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
    <div className="flex flex-wrap gap-1">{children}</div>
  </div>
);

const Chip: React.FC<{
  active?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}> = ({ active, onClick, title, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
      active
        ? 'bg-primary-500/30 text-primary-100 ring-1 ring-primary-400/60'
        : 'bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
    }`}
  >
    {children}
  </button>
);

const ColorSwatch: React.FC<{
  color: string;
  shade: number;
  active?: boolean;
  onClick: () => void;
}> = ({ color, shade, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    title={`${color}-${shade}`}
    className={`h-5 w-5 rounded transition-transform hover:scale-110 ${
      active ? 'ring-2 ring-white' : ''
    }`}
    style={{ backgroundColor: tailwindHex(color, shade) }}
  />
);

// 默认 palette 简表（用 CSS color name 兜底，准确度够 demo）
function tailwindHex(color: string, shade: number): string {
  // 简化映射：Tailwind 实际有完整 color palette，这里只用 swatch 视觉效果
  // 准确颜色由 vite HMR 后用户在 iframe 看到，这里只要能区分色族就行
  const palette: Record<string, string[]> = {
    slate: ['#f8fafc', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#334155', '#1e293b', '#0f172a'],
    gray: ['#f9fafb', '#f3f4f6', '#e5e7eb', '#d1d5db', '#9ca3af', '#6b7280', '#4b5563', '#374151', '#1f2937', '#111827'],
    zinc: ['#fafafa', '#f4f4f5', '#e4e4e7', '#d4d4d8', '#a1a1aa', '#71717a', '#52525b', '#3f3f46', '#27272a', '#18181b'],
    red: ['#fef2f2', '#fee2e2', '#fecaca', '#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d'],
    orange: ['#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412', '#7c2d12'],
    amber: ['#fffbeb', '#fef3c7', '#fde68a', '#fcd34d', '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e', '#78350f'],
    yellow: ['#fefce8', '#fef9c3', '#fef08a', '#fde047', '#facc15', '#eab308', '#ca8a04', '#a16207', '#854d0e', '#713f12'],
    lime: ['#f7fee7', '#ecfccb', '#d9f99d', '#bef264', '#a3e635', '#84cc16', '#65a30d', '#4d7c0f', '#3f6212', '#365314'],
    green: ['#f0fdf4', '#dcfce7', '#bbf7d0', '#86efac', '#4ade80', '#22c55e', '#16a34a', '#15803d', '#166534', '#14532d'],
    emerald: ['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b'],
    teal: ['#f0fdfa', '#ccfbf1', '#99f6e4', '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e', '#115e59', '#134e4a'],
    cyan: ['#ecfeff', '#cffafe', '#a5f3fc', '#67e8f9', '#22d3ee', '#06b6d4', '#0891b2', '#0e7490', '#155e75', '#164e63'],
    sky: ['#f0f9ff', '#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1', '#075985', '#0c4a6e'],
    blue: ['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a'],
    indigo: ['#eef2ff', '#e0e7ff', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81'],
    violet: ['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95'],
    purple: ['#faf5ff', '#f3e8ff', '#e9d5ff', '#d8b4fe', '#c084fc', '#a855f7', '#9333ea', '#7e22ce', '#6b21a8', '#581c87'],
    fuchsia: ['#fdf4ff', '#fae8ff', '#f5d0fe', '#f0abfc', '#e879f9', '#d946ef', '#c026d3', '#a21caf', '#86198f', '#701a75'],
    pink: ['#fdf2f8', '#fce7f3', '#fbcfe8', '#f9a8d4', '#f472b6', '#ec4899', '#db2777', '#be185d', '#9d174d', '#831843'],
    rose: ['#fff1f2', '#ffe4e6', '#fecdd3', '#fda4af', '#fb7185', '#f43f5e', '#e11d48', '#be123c', '#9f1239', '#881337'],
  };
  const idx = COLOR_SHADES.indexOf(shade);
  return palette[color]?.[idx] ?? '#71717a';
}

// ----------------------------------------------------------------------------
// TweakPanel
// ----------------------------------------------------------------------------

export const TweakPanel: React.FC<Props> = ({ selected, collapsed, onToggleCollapsed }) => {
  const [colorTarget, setColorTarget] = useState<ColorTarget>('bg');
  const [spacingAxis, setSpacingAxis] = useState<SpacingAxis>('p');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const inferred = useMemo(() => inferState(selected.className), [selected.className]);
  const hasNoClassName = selected.className === undefined || selected.className === '';

  const dispatch = useCallback(
    async (mutation: ClassMutation) => {
      setError(null);
      setPending(true);
      try {
        const res = await dispatchTweak(selected, mutation);
        if (!res.ok) {
          setError(res.reason === 'expression'
            ? 'className 是表达式（cn/三元等），需走 visual_edit'
            : `${res.reason}: ${res.detail ?? ''}`);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(false);
      }
    },
    [selected],
  );

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-md bg-zinc-800/90 px-2 py-1 text-[10px] text-zinc-200 hover:bg-zinc-700 backdrop-blur"
        title="展开 Tweak 面板"
      >
        <Sparkles className="h-3 w-3" />
        Tweak
      </button>
    );
  }

  return (
    <div className="w-72 shrink-0 border-l border-zinc-800 bg-zinc-900 overflow-y-auto" data-testid="tweak-panel">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
          <Sparkles className="h-3.5 w-3.5 text-primary-400" />
          Tweak
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="text-[10px] text-zinc-500 hover:text-zinc-300"
        >
          收起
        </button>
      </header>

      {hasNoClassName ? (
        <div className="px-3 py-4 text-[11px] leading-relaxed text-zinc-400">
          元素无 className 属性。Tweak 面板只能在已有 className 字面量的元素上工作。
          先给元素加 <code className="rounded bg-zinc-800 px-1">className=&quot;&quot;</code> 后再选中。
        </div>
      ) : (
        <div className="space-y-4 px-3 py-3">
          {/* current className 字符串 */}
          <div className="rounded-md bg-zinc-950 px-2 py-1.5 font-mono text-[10px] leading-snug text-zinc-400 break-all">
            {selected.className}
          </div>

          {/* 颜色 */}
          <Section label={`Color · ${colorTarget}`}>
            <div className="flex w-full items-center gap-1">
              {(['text', 'bg', 'border'] as ColorTarget[]).map((t) => (
                <Chip key={t} active={colorTarget === t} onClick={() => setColorTarget(t)}>
                  {t}
                </Chip>
              ))}
            </div>
            <div className="mt-1 grid w-full grid-cols-10 gap-0.5">
              {COLOR_FAMILIES.flatMap((color) =>
                COLOR_SHADES.slice(3, 8).map((shade) => {
                  const current = inferred.color[colorTarget];
                  const active = current?.color === color && current?.shade === shade;
                  return (
                    <ColorSwatch
                      key={`${color}-${shade}`}
                      color={color}
                      shade={shade}
                      active={active}
                      onClick={() => dispatch({ kind: 'color', target: colorTarget, color, shade })}
                    />
                  );
                }),
              )}
            </div>
          </Section>

          {/* 间距 */}
          <Section label={`Spacing · ${spacingAxis}`}>
            <div className="flex w-full flex-wrap gap-1">
              {SPACING_AXES.map((axis) => (
                <Chip key={axis} active={spacingAxis === axis} onClick={() => setSpacingAxis(axis)}>
                  {axis}
                </Chip>
              ))}
            </div>
            <div className="mt-1 grid w-full grid-cols-7 gap-1">
              {SPACING_VALUES.map((v) => (
                <Chip
                  key={v}
                  active={inferred.spacing[spacingAxis] === v}
                  onClick={() => dispatch({ kind: 'spacing', axis: spacingAxis, value: v })}
                >
                  {v}
                </Chip>
              ))}
            </div>
          </Section>

          {/* 字号 */}
          <Section label="Font Size">
            {FONT_SIZES.map((s) => (
              <Chip
                key={s}
                active={inferred.fontSize === s}
                onClick={() => dispatch({ kind: 'fontSize', size: s })}
              >
                {s}
              </Chip>
            ))}
          </Section>

          {/* 圆角 */}
          <Section label="Radius">
            {RADIUS_SIZES.map((s) => (
              <Chip
                key={s || 'default'}
                active={inferred.radius === s}
                onClick={() => dispatch({ kind: 'radius', size: s })}
              >
                {s || 'def'}
              </Chip>
            ))}
          </Section>

          {/* 对齐 */}
          <Section label="Text Align">
            {(['left', 'center', 'right'] as const).map((v) => (
              <Chip
                key={v}
                active={inferred.textAlign === v}
                onClick={() => dispatch({ kind: 'align', axis: 'text', value: v })}
              >
                {v}
              </Chip>
            ))}
          </Section>
          <Section label="Items Align">
            {(['start', 'center', 'end'] as const).map((v) => (
              <Chip
                key={v}
                active={inferred.itemsAlign === v}
                onClick={() => dispatch({ kind: 'align', axis: 'items', value: v })}
              >
                {v}
              </Chip>
            ))}
          </Section>
          <Section label="Justify">
            {(['start', 'center', 'end', 'between'] as const).map((v) => (
              <Chip
                key={v}
                active={inferred.justifyAlign === v}
                onClick={() => dispatch({ kind: 'align', axis: 'justify', value: v })}
              >
                {v}
              </Chip>
            ))}
          </Section>

          {pending && <div className="text-[10px] text-zinc-500">applying…</div>}
          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-amber-900/40 bg-amber-950/20 px-2 py-1.5 text-[10px] text-amber-200">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="leading-snug">{error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TweakPanel;
