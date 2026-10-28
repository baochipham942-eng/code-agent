// ============================================================================
// Load the side-panel payload for text, HEIC, and legacy Office.
// Other kinds return null so PreviewPanel keeps its existing loaders.
// ============================================================================

import { previewDispatch } from './previewable';

type CallWorkspace = <T>(action: string, payload?: unknown) => Promise<T>;

export async function loadFormatPreview(filePath: string, callWorkspace: CallWorkspace): Promise<string | null> {
  const dispatch = previewDispatch(filePath);
  if (dispatch.isText || dispatch.kind === null) {
    return JSON.stringify(await callWorkspace('readTextPreview', { filePath }));
  }
  if (dispatch.isHeic) {
    return JSON.stringify(await callWorkspace('previewHeic', { filePath }));
  }
  if (dispatch.isLegacyOffice) {
    return JSON.stringify(await callWorkspace('previewLegacyOffice', { filePath }));
  }
  return null;
}
