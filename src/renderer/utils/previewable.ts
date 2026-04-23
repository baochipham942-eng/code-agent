// ============================================================================
// Previewable file types — single source of truth for the in-app PreviewPanel
// ============================================================================
//
// Any file with one of these extensions can be opened in the PreviewPanel
// (see src/renderer/components/PreviewPanel.tsx). Chat-surface components that
// offer an "Open preview" button should gate on this list so the UI matches
// what the panel actually renders.
//
// Keep in sync with PreviewPanel's supported renderers:
//   - markdown: md / mdx / markdown
//   - table:    csv / tsv
//   - html:     html / htm
//   - text fallthrough (iframe srcDoc): txt
//
// ts/tsx/jsx/json/yaml are intentionally excluded until Phase 3.3 adds a
// proper CodeMirror-backed editor for them.
// ============================================================================

export const PREVIEWABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'md', 'mdx', 'markdown',
  'csv', 'tsv',
  'html', 'htm',
  'txt',
]);

export function getFileExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
}

export function isPreviewable(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  return PREVIEWABLE_EXTENSIONS.has(getFileExtension(filePath));
}
