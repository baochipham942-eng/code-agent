// ============================================================================
// MarkdownEditor - CodeMirror 6 wrapper tuned for inline editing inside the
// PreviewPanel. Dynamically imported so the editor chunk only loads when the
// user clicks Edit on a markdown file.
// ============================================================================

import React, { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';

interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  readOnly?: boolean;
}

const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  value, onChange, onSave, readOnly = false,
}) => {
  // Highest precedence so Cmd/Ctrl+S beats the browser's default save dialog.
  const saveKeymap = useMemo(() => Prec.highest(keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        onSave();
        return true;
      },
    },
  ])), [onSave]);

  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: [] }),
    EditorView.lineWrapping,
    saveKeymap,
  ], [saveKeymap]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={oneDark}
      extensions={extensions}
      readOnly={readOnly}
      height="100%"
      style={{ height: '100%', fontSize: 13 }}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        bracketMatching: true,
        autocompletion: false,
      }}
    />
  );
};

export default MarkdownEditor;
