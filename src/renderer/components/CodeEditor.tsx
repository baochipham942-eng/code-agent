// ============================================================================
// CodeEditor - CodeMirror 6 wrapper for inline editing inside the PreviewPanel.
// Dynamically imported so the editor chunk only loads when the user opens a
// previewable code or markdown file.
// ============================================================================

import React, { useMemo } from 'react';
import CodeMirror, { type Extension } from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';

export type CodeEditorLanguage =
  | 'markdown'
  | 'json'
  | 'yaml'
  | 'javascript'
  | 'typescript'
  | 'text';

interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  language: CodeEditorLanguage;
  readOnly?: boolean;
}

function languageExtension(language: CodeEditorLanguage): Extension | null {
  switch (language) {
    case 'markdown':
      return markdown({ base: markdownLanguage, codeLanguages: [] });
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    case 'javascript':
      return javascript({ jsx: true });
    case 'typescript':
      return javascript({ jsx: true, typescript: true });
    case 'text':
      return null;
  }
}

const CodeEditor: React.FC<CodeEditorProps> = ({
  value, onChange, onSave, language, readOnly = false,
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

  const extensions = useMemo(() => {
    const langExt = languageExtension(language);
    const base: Extension[] = [EditorView.lineWrapping, saveKeymap];
    return langExt ? [langExt, ...base] : base;
  }, [language, saveKeymap]);

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

export default CodeEditor;
