import React, { useEffect, useRef, useState } from 'react';
import { EditorState, type Text } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { getChunks, MergeView, unifiedMergeView, type Chunk } from '@codemirror/merge';
import type { CodeMirrorDiffViewProps } from './DiffView.types';

type ViewMode = 'unified' | 'split';

const mergeTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg-surface)',
    color: 'var(--text-secondary)',
    fontSize: '12px',
  },
  '&.cm-focused': { outline: '1px solid var(--border-focus)' },
  '.cm-scroller': {
    maxHeight: '28rem',
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
  '.cm-content': { caretColor: 'transparent' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-deep)',
    color: 'var(--text-tertiary)',
    borderRight: '1px solid var(--border-default)',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--selection-bg)',
  },
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk, .cm-deletedLine': {
    backgroundColor: 'var(--badge-danger-bg)',
  },
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': {
    backgroundColor: 'var(--badge-success-bg)',
  },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': {
    backgroundColor: 'var(--badge-danger-border)',
  },
  '&.cm-merge-b .cm-changedText': {
    backgroundColor: 'var(--badge-success-border)',
  },
  '.cm-deletedChunk': { color: 'var(--badge-danger-fg)' },
  '.cm-insertedLine': { color: 'var(--badge-success-fg)' },
  '.cm-changedLineGutter, .cm-deletedLineGutter': {
    backgroundColor: 'var(--badge-danger-fg)',
  },
  '&.cm-merge-b .cm-changedLineGutter': {
    backgroundColor: 'var(--badge-success-fg)',
  },
  '.cm-collapsedLines': {
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-default)',
  },
});

const readOnlyExtensions = (ariaLabel: string) => [
  lineNumbers(),
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
  mergeTheme,
];

function changedLineCount(doc: Text, from: number, to: number): number {
  if (from === to) return 0;
  const safeFrom = Math.min(from, doc.length);
  const safeTo = Math.min(Math.max(from, to - 1), doc.length);
  return doc.lineAt(safeTo).number - doc.lineAt(safeFrom).number + 1;
}

function summarizeChunks(chunks: readonly Chunk[], oldDoc: Text, newDoc: Text) {
  return chunks.reduce(
    (stats, chunk) => ({
      added: stats.added + changedLineCount(newDoc, chunk.fromB, chunk.toB),
      removed: stats.removed + changedLineCount(oldDoc, chunk.fromA, chunk.toA),
    }),
    { added: 0, removed: 0 },
  );
}

const ToggleButton: React.FC<{
  active: boolean;
  label: string;
  onClick: () => void;
}> = ({ active, label, onClick }) => (
  <button
    type="button"
    aria-pressed={active}
    onClick={onClick}
    className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
      active
        ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
        : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]'
    }`}
  >
    {label}
  </button>
);

const CodeMirrorDiffView: React.FC<CodeMirrorDiffViewProps> = ({
  oldText,
  newText,
  fileName,
  className = '',
  stats: providedStats,
  labels,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const addedRef = useRef<HTMLSpanElement>(null);
  const removedRef = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<ViewMode>('unified');
  const [collapse, setCollapse] = useState(false);
  const [inline, setInline] = useState(false);
  const providedAdded = providedStats?.added;
  const providedRemoved = providedStats?.removed;

  useEffect(() => {
    const parent = mountRef.current;
    if (!parent || oldText === newText) return;

    if (rootRef.current) rootRef.current.dataset.diffRenderComplete = 'false';
    const collapseUnchanged = collapse ? { margin: 3, minSize: 8 } : undefined;
    let destroy: () => void;
    let chunks: readonly Chunk[];
    let oldDoc: Text;
    let newDoc: Text;

    if (mode === 'split') {
      const mergeView = new MergeView({
        parent,
        a: { doc: oldText, extensions: readOnlyExtensions(labels.readOnlyAria) },
        b: { doc: newText, extensions: readOnlyExtensions(labels.readOnlyAria) },
        highlightChanges: false,
        gutter: true,
        collapseUnchanged,
      });
      chunks = mergeView.chunks;
      oldDoc = mergeView.a.state.doc;
      newDoc = mergeView.b.state.doc;
      destroy = () => mergeView.destroy();
    } else {
      const view = new EditorView({
        parent,
        doc: newText,
        extensions: [
          ...readOnlyExtensions(labels.readOnlyAria),
          unifiedMergeView({
            original: oldText,
            highlightChanges: inline,
            gutter: true,
            allowInlineDiffs: inline,
            mergeControls: false,
            collapseUnchanged,
          }),
        ],
      });
      chunks = getChunks(view.state)?.chunks ?? [];
      oldDoc = EditorState.create({ doc: oldText }).doc;
      newDoc = view.state.doc;
      destroy = () => view.destroy();
    }

    const stats = providedAdded !== undefined && providedRemoved !== undefined
      ? { added: providedAdded, removed: providedRemoved }
      : summarizeChunks(chunks, oldDoc, newDoc);
    if (addedRef.current) {
      addedRef.current.textContent = `+${stats.added}`;
      addedRef.current.hidden = stats.added === 0;
    }
    if (removedRef.current) {
      removedRef.current.textContent = `-${stats.removed}`;
      removedRef.current.hidden = stats.removed === 0;
    }
    if (rootRef.current) rootRef.current.dataset.diffRenderComplete = 'true';
    return destroy;
  }, [collapse, inline, labels.readOnlyAria, mode, newText, oldText, providedAdded, providedRemoved]);

  if (oldText === newText) {
    return <div className={`p-2 text-sm text-[var(--text-tertiary)] ${className}`}>{labels.noChanges}</div>;
  }

  return (
    <div
      ref={rootRef}
      className={`diff-view overflow-hidden rounded-lg ${className}`}
      data-diff-render-complete="false"
      data-diff-renderer="codemirror-merge"
      data-diff-view-mode={mode}
    >
      <div className="diff-stats flex items-center gap-3 border-b border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2">
        {fileName && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-secondary)]">
            {fileName}
          </span>
        )}
        <div className="flex items-center gap-1" role="group">
          <ToggleButton active={mode === 'unified'} label={labels.unified} onClick={() => setMode('unified')} />
          <ToggleButton active={mode === 'split'} label={labels.split} onClick={() => setMode('split')} />
          <ToggleButton
            active={collapse}
            label={collapse ? labels.expandUnchanged : labels.collapseUnchanged}
            onClick={() => setCollapse((value) => !value)}
          />
          {mode === 'unified' && (
            <ToggleButton
              active={inline}
              label={inline ? labels.lineChanges : labels.inlineChanges}
              onClick={() => setInline((value) => !value)}
            />
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span ref={addedRef} hidden className="text-badge-success" />
          <span ref={removedRef} hidden className="text-badge-danger" />
        </div>
      </div>
      <div ref={mountRef} className="diff-content bg-[var(--bg-surface)]" />
    </div>
  );
};

export default CodeMirrorDiffView;
