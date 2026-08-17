import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { PreviewTab } from '../stores/appStore';
import { useI18n } from '../hooks/useI18n';

interface ArtifactFollowToolbarProps {
  phase?: 'generating' | 'complete';
  paused: boolean;
  hasSourceModes: boolean;
  mode: PreviewTab['mode'];
  completedMeta: string | null;
  onModeChange: (mode: PreviewTab['mode']) => void;
  onFollowToggle: () => void;
}

export const ArtifactFollowToolbar: React.FC<ArtifactFollowToolbarProps> = ({
  phase,
  paused,
  hasSourceModes,
  mode,
  completedMeta,
  onModeChange,
  onFollowToggle,
}) => {
  const { t } = useI18n();
  const pv = t.previewWorkspace.preview;

  if (phase === 'generating') {
    return (
      <div
        data-testid="artifact-follow-generating"
        className="flex shrink-0 items-center gap-2 border-b border-badge-info/20 bg-surface-subtle px-3 py-1.5 text-[11px] text-badge-info"
      >
        <RefreshCw className={`h-3 w-3 ${paused ? '' : 'animate-spin'}`} />
        <span>{paused ? pv.followPaused : pv.generating}</span>
        <button /* ds-allow:button: compact inline follow toggle */
          type="button"
          onClick={onFollowToggle}
          className="ml-auto rounded px-1.5 py-0.5 text-zinc-500 transition-colors hover:bg-surface-hover hover:text-zinc-200"
        >
          {paused ? pv.resumeFollow : pv.pauseFollow}
        </button>
      </div>
    );
  }

  if (!hasSourceModes && !completedMeta) return null;
  return (
    <div
      data-testid="artifact-follow-complete"
      className="flex shrink-0 items-center gap-2 border-b border-border-muted bg-surface-subtle px-3 py-1.5"
    >
      {hasSourceModes && (
        <div className="inline-flex overflow-hidden rounded-md border border-border-muted text-[11px]">
          {/* ds-allow:start compact segmented preview/source/edit control */}
          {(['preview', 'source', 'edit'] as const).map((nextMode) => (
            <button
              key={nextMode}
              type="button"
              data-testid={`preview-mode-${nextMode}`}
              aria-pressed={mode === nextMode}
              onClick={() => onModeChange(nextMode)}
              className={`px-2.5 py-1 transition-colors ${
                mode === nextMode
                  ? 'bg-surface-hover text-zinc-200'
                  : 'text-zinc-500 hover:bg-surface-hover hover:text-zinc-300'
              }`}
            >
              {nextMode === 'preview'
                ? pv.previewMode
                : nextMode === 'source'
                  ? pv.sourceMode
                  : pv.editMode}
            </button>
          ))}
          {/* ds-allow:end */}
        </div>
      )}
      {completedMeta && <span className="ml-auto truncate text-[11px] text-zinc-500">{completedMeta}</span>}
      {paused && phase && (
        <button /* ds-allow:button: compact inline follow toggle */
          type="button"
          onClick={onFollowToggle}
          className={`${completedMeta ? '' : 'ml-auto'} rounded px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-surface-hover hover:text-zinc-200`}
        >
          {pv.resumeFollow}
        </button>
      )}
    </div>
  );
};

export const ArtifactPreviewLoading: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex h-full items-center justify-center bg-zinc-700">
    <div className="flex flex-col items-center gap-3">
      <RefreshCw className="h-8 w-8 animate-spin text-zinc-400" />
      <span className="text-sm text-zinc-400">{label}</span>
    </div>
  </div>
);
