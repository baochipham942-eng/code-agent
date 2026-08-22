import React, { Suspense, lazy } from 'react';
import type { PreviewTab } from '../stores/appStore';

const CodeEditor = lazy(() => import('./CodeEditor'));

interface ArtifactSourceEditorProps {
  mode: Extract<PreviewTab['mode'], 'source' | 'edit'>;
  content: string;
  markdown: boolean;
  loadingLabel: string;
  onChange: (content: string) => void;
  onSave: () => void;
  jumpToLine?: number;
  jumpNonce?: number;
  readOnly?: boolean;
}

export const ArtifactSourceEditor: React.FC<ArtifactSourceEditorProps> = ({
  mode,
  content,
  markdown,
  loadingLabel,
  onChange,
  onSave,
  jumpToLine,
  jumpNonce,
  readOnly = false,
}) => (
  <Suspense
    fallback={(
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        {loadingLabel}
      </div>
    )}
  >
    <CodeEditor
      value={content}
      onChange={mode === 'source' || readOnly ? () => {} : onChange}
      onSave={mode === 'source' || readOnly ? () => {} : onSave}
      language={markdown ? 'markdown' : 'text'}
      readOnly={mode === 'source' || readOnly}
      jumpToLine={mode === 'edit' ? jumpToLine : undefined}
      jumpNonce={mode === 'edit' ? jumpNonce : undefined}
    />
  </Suspense>
);
