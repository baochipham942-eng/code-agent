import type { ReactNode } from 'react';
import { LayoutGrid, Play, Sparkles, X } from 'lucide-react';
import type {
  WorkspacePreviewItem,
  WorkspacePreviewKind,
} from '@shared/contract';
import {
  createWorkbenchRecipeMergedContext,
  type WorkbenchPreset,
  type WorkbenchRecipe,
} from '@shared/contract/workbenchPreset';

export type WorkspaceAssetTab = 'apps' | 'gallery' | 'preview';

const VISUAL_ASSET_KINDS = new Set<WorkspacePreviewKind>([
  'chart',
  'diagram',
  'design_ppt',
  'generic_html',
  'image',
  'video',
  'web_snapshot',
]);

export function isGalleryItem(item: WorkspacePreviewItem): boolean {
  return Boolean(item.content?.imageDataUrl) || VISUAL_ASSET_KINDS.has(item.kind);
}

function formatAssetTime(ms: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

function basename(path?: string | null): string {
  if (!path) return '未绑定工作区';
  return path.split('/').filter(Boolean).pop() || path;
}

function presetContextSummary(preset: WorkbenchPreset): string {
  const context = preset.context;
  const capabilityCount =
    context.selectedSkillIds.length +
    context.selectedConnectorIds.length +
    context.selectedMcpServerIds.length;
  const parts = [
    basename(context.workingDirectory),
    context.routingMode,
    capabilityCount > 0 ? `${capabilityCount} capabilities` : null,
    context.browserSessionMode !== 'none' ? context.browserSessionMode : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

function recipeSummary(recipe: WorkbenchRecipe): string {
  const context = createWorkbenchRecipeMergedContext(recipe);
  const parts = [
    `${recipe.steps.length} steps`,
    basename(context.workingDirectory),
    context.routingMode,
  ].filter(Boolean);
  return parts.join(' · ');
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function AssetTabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs transition-colors ${
        active
          ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200'
          : 'border-white/[0.08] bg-white/[0.025] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200'
      }`}
    >
      <span>{label}</span>
      <span className="text-[10px] opacity-70">{count}</span>
    </button>
  );
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function AssetToolbarButton({
  label,
  icon,
  count,
  active = false,
  disabled = false,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  icon: ReactNode;
  count?: number;
  active?: boolean;
  disabled?: boolean;
  tone?: 'neutral' | 'cyan';
  onClick: () => void;
}) {
  const activeClass = tone === 'cyan'
    ? 'border-cyan-500/30 bg-cyan-500/[0.10] text-cyan-200'
    : 'border-white/[0.14] bg-white/[0.07] text-zinc-100';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors ${
        active
          ? activeClass
          : 'border-white/[0.08] bg-white/[0.025] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {icon}
      {count !== undefined && count > 0 && (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full border border-zinc-900 bg-cyan-500 px-1 text-[9px] font-medium leading-4 text-zinc-950">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function AssetDrawerPanel({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside
      role="dialog"
      aria-label={title}
      className="absolute inset-y-0 right-0 z-30 flex w-[min(360px,calc(100%-44px))] flex-col border-l border-white/[0.08] bg-zinc-900 shadow-2xl"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100">{title}</div>
          {subtitle && <div className="mt-0.5 truncate text-xs text-zinc-500">{subtitle}</div>}
        </div>
        <button
          type="button"
          aria-label="关闭面板"
          title="关闭面板"
          onClick={onClose}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.025] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
    </aside>
  );
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function PromptAppLibrary({
  presets,
  recipes,
  onUsePreset,
  onUseRecipe,
}: {
  presets: WorkbenchPreset[];
  recipes: WorkbenchRecipe[];
  onUsePreset: (preset: WorkbenchPreset) => void;
  onUseRecipe: (recipe: WorkbenchRecipe) => void;
}) {
  if (presets.length === 0 && recipes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div>
          <Sparkles className="mx-auto h-8 w-8 text-zinc-600" />
          <div className="mt-3 text-sm text-zinc-300">暂无 Prompt Apps</div>
          <div className="mt-1 max-w-sm text-xs leading-relaxed text-zinc-500">
            从会话右键保存工作台为 Preset，或把多个 Preset 合成 Recipe 后，会出现在这里。
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="space-y-5">
        {recipes.length > 0 && (
          <section>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-zinc-200">
              <LayoutGrid className="h-3.5 w-3.5 text-cyan-300" />
              Recipes
            </div>
            <div className="grid gap-2">
              {recipes.map((recipe) => (
                <div
                  key={recipe.id}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.025] p-3"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-zinc-100">{recipe.name}</div>
                      <div className="mt-1 truncate text-xs text-zinc-500">{recipeSummary(recipe)}</div>
                      {recipe.description && (
                        <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">
                          {recipe.description}
                        </div>
                      )}
                      <div className="mt-1 text-[11px] text-zinc-600">
                        updated {formatAssetTime(recipe.updatedAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onUseRecipe(recipe)}
                      className="inline-flex items-center gap-1 rounded-md border border-cyan-500/20 bg-cyan-500/[0.08] px-2.5 py-1 text-xs text-cyan-200 hover:bg-cyan-500/[0.14]"
                    >
                      <Play className="h-3 w-3" />
                      Use
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {presets.length > 0 && (
          <section>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-zinc-200">
              <Sparkles className="h-3.5 w-3.5 text-violet-300" />
              Presets
            </div>
            <div className="grid gap-2">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.025] p-3"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-zinc-100">{preset.name}</div>
                      <div className="mt-1 truncate text-xs text-zinc-500">{presetContextSummary(preset)}</div>
                      {preset.description && (
                        <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">
                          {preset.description}
                        </div>
                      )}
                      {preset.source.kind === 'session' && preset.source.sessionTitle && (
                        <div className="mt-1 truncate text-[11px] text-zinc-600">
                          from {preset.source.sessionTitle}
                        </div>
                      )}
                      <div className="mt-1 text-[11px] text-zinc-600">
                        updated {formatAssetTime(preset.updatedAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onUsePreset(preset)}
                      className="inline-flex items-center gap-1 rounded-md border border-violet-500/20 bg-violet-500/[0.08] px-2.5 py-1 text-xs text-violet-200 hover:bg-violet-500/[0.14]"
                    >
                      <Play className="h-3 w-3" />
                      Use
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
