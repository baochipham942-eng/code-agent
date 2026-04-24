// ============================================================================
// CodeEditor - CodeMirror 6 wrapper for inline editing inside the PreviewPanel.
// Dynamically imported so the editor chunk only loads when the user opens a
// previewable code or markdown file.
// ============================================================================

import React, { useEffect, useMemo, useRef } from 'react';
import CodeMirror, { type Extension } from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { Prec, EditorSelection } from '@codemirror/state';

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
  /**
   * Visual Grounding: Live Preview 选中元素后驱动的行跳转
   * 每次 line 变化（即使相同值），外层通过 `jumpNonce` bump 一次即可重新滚动/高亮
   */
  jumpToLine?: number;
  jumpNonce?: number;
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
  value, onChange, onSave, language, readOnly = false, jumpToLine, jumpNonce,
}) => {
  const viewRef = useRef<EditorView | null>(null);

  // 根据 jumpToLine (+ jumpNonce) 滚动到目标行并选中
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jumpToLine || jumpToLine < 1) return;
    const doc = view.state.doc;
    if (jumpToLine > doc.lines) return;
    const line = doc.line(jumpToLine);
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  }, [jumpToLine, jumpNonce]);

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
      onCreateEditor={(view) => {
        viewRef.current = view;
      }}
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
