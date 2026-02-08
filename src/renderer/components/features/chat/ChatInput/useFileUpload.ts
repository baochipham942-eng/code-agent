// ============================================================================
// useFileUpload - 文件上传处理 Hook
// ============================================================================

import { useCallback } from 'react';
import type { MessageAttachment } from '../../../../../shared/types';
import {
  MAX_FILE_SIZE,
  MAX_FOLDER_FILES,
  getFileCategory,
  readDirectoryEntry,
  extractPdfText,
  generateAttachmentId,
} from './utils';
import { useUIStore } from '../../../../stores/uiStore';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('useFileUpload');

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

/**
 * 文件上传处理 Hook
 * 处理单个文件和文件夹的上传逻辑
 */
export function useFileUpload() {
  const showToast = useUIStore((state) => state.showToast);

  // 处理单个文件
  const processFile = useCallback(async (file: File): Promise<MessageAttachment | null> => {
    const { category, language } = getFileCategory(file);
    const id = generateAttachmentId();
    const relativePath = (file as File & { relativePath?: string }).relativePath;
    const displayName = relativePath || file.name;

    let filePath: string | undefined;
    try {
      filePath = window.electronAPI?.getPathForFile(file);
    } catch (e) {
      logger.warn('processFile - failed to get path', { error: e });
    }

    // PDF 大文件只传路径，不受 MAX_FILE_SIZE 限制
    if (category === 'pdf' && filePath) {
      const { text, pageCount } = await extractPdfText(filePath);
      return {
        id, type: 'file', category: 'pdf', name: displayName, size: file.size,
        mimeType: 'application/pdf', data: text, pageCount, path: filePath,
      };
    }

    // 非 PDF 文件超限时 toast 提示
    if (file.size > MAX_FILE_SIZE) {
      logger.warn('File is too large (max 10MB)', { fileName: file.name, size: file.size });
      showToast('warning', `文件 "${file.name}" 太大（${formatFileSize(file.size)}），最大支持 10MB`);
      return null;
    }

    if (category === 'document') {
      logger.warn('Office documents (.docx, .pptx) are not yet supported');
      return null;
    }

    // Excel 文件处理
    if (category === 'excel' && filePath) {
      const result = await window.electronAPI?.extractExcelText(filePath);
      if (result) {
        return {
          id, type: 'file', category: 'excel', name: displayName, size: file.size,
          mimeType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: result.text, sheetCount: result.sheetCount, rowCount: result.rowCount, path: filePath,
        };
      }
      logger.warn('Excel extraction failed, falling back to binary warning');
      return null;
    }

    if (category === 'image') {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const data = e.target?.result as string;
          resolve({
            id, type: 'image', category: 'image', name: displayName, size: file.size,
            mimeType: file.type, data, thumbnail: data, path: filePath,
          });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = e.target?.result as string;
        resolve({
          id, type: 'file', category, name: displayName, size: file.size,
          mimeType: file.type || 'text/plain', data, language, path: filePath,
        });
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
  }, [showToast]);

  // 处理文件夹
  const processFolderEntry = useCallback(async (
    dirEntry: FileSystemDirectoryEntry,
    folderName: string
  ): Promise<MessageAttachment | null> => {
    const files = await readDirectoryEntry(dirEntry, folderName);
    if (files.length === 0) {
      logger.warn('文件夹中没有可处理的文件', { folderName });
      return null;
    }

    let folderPath: string | undefined;
    try {
      const firstFile = files[0];
      const firstFilePath = window.electronAPI?.getPathForFile(firstFile);
      if (firstFilePath) {
        const relativePath = (firstFile as File & { relativePath?: string }).relativePath;
        if (relativePath) {
          const relativeDir = relativePath.split('/').slice(0, 1).join('/');
          const idx = firstFilePath.lastIndexOf('/' + relativeDir + '/');
          if (idx !== -1) {
            folderPath = firstFilePath.substring(0, idx + 1 + relativeDir.length);
          }
        } else {
          folderPath = firstFilePath.substring(0, firstFilePath.lastIndexOf('/'));
        }
      }
    } catch (e) {
      logger.warn('processFolderEntry - failed to get folder path', { error: e });
    }

    const filesToProcess = files.slice(0, MAX_FOLDER_FILES);
    const fileContents: Array<{ path: string; content: string; size: number }> = [];
    const byType: Record<string, number> = {};
    let totalSize = 0;

    for (const file of filesToProcess) {
      const relativePath = (file as File & { relativePath?: string }).relativePath || file.name;
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      byType[ext] = (byType[ext] || 0) + 1;
      totalSize += file.size;

      try {
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.onerror = () => reject(new Error('读取失败'));
          reader.readAsText(file);
        });
        fileContents.push({ path: relativePath, content, size: file.size });
      } catch {
        logger.warn('无法读取文件', { path: relativePath });
      }
    }

    const id = generateAttachmentId();
    const typeStats = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, count]) => `${ext}(${count})`)
      .join(', ');
    const summary = `${files.length} 个文件${files.length > MAX_FOLDER_FILES ? ` (仅处理前 ${MAX_FOLDER_FILES} 个)` : ''}: ${typeStats}`;

    return {
      id, type: 'file', category: 'folder', name: folderName, size: totalSize,
      mimeType: 'inode/directory', data: summary, files: fileContents, path: folderPath,
      folderStats: { totalFiles: files.length, totalSize, byType },
    };
  }, []);

  return { processFile, processFolderEntry };
}

export default useFileUpload;
