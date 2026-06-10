// ============================================================================
// saveTextFile - 导出文本文件
// Tauri 桌面版：原生「另存为」对话框（用户选位置）→ WORKSPACE.writeFile 落盘
// Web 模式：浏览器 Blob 下载（落默认下载目录）
// ============================================================================

import { IPC_DOMAINS } from '@shared/ipc';
import { isTauriMode } from './platform';

export interface SaveTextFileOptions {
  content: string;
  fileName: string;
  /** 浏览器下载用 MIME，如 'application/json;charset=utf-8' */
  mimeType: string;
  /** 原生另存为的扩展名过滤（如 ['json']），仅 Tauri 模式生效 */
  extensions?: string[];
}

/** 返回 true=已保存，false=用户取消另存为对话框。写盘失败时抛错。 */
export async function saveTextFile({ content, fileName, mimeType, extensions }: SaveTextFileOptions): Promise<boolean> {
  if (isTauriMode()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const filePath = await save({
      defaultPath: fileName,
      filters: extensions?.length ? [{ name: extensions.join('/'), extensions }] : undefined,
    });
    if (!filePath) return false;
    const response = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'writeFile', { filePath, content });
    if (!response?.success) {
      throw new Error(response?.error?.message || `Failed to write ${filePath}`);
    }
    return true;
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
