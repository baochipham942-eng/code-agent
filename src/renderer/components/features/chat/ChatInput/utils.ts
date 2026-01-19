// ============================================================================
// ChatInput 工具函数 - 文件处理相关
// ============================================================================

import type { AttachmentCategory } from '../../../../../shared/types';

// ============================================================================
// 文件类型配置
// ============================================================================

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export const CODE_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala',
  '.php': 'php', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.sql': 'sql', '.r': 'r', '.lua': 'lua', '.vim': 'vim', '.el': 'elisp',
};

export const STYLE_EXTENSIONS: Record<string, string> = {
  '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
};

export const DATA_EXTENSIONS = ['.json', '.csv', '.xml', '.yaml', '.yml', '.toml'];
export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.rst', '.log'];
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const IGNORED_DIRS = ['node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store', 'dist', 'build', '.next', '.cache'];
export const MAX_FOLDER_FILES = 50;

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 根据文件信息判断类别
 */
export function getFileCategory(file: File): { category: AttachmentCategory; language?: string } {
  const mimeType = file.type.toLowerCase();
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();

  if (IMAGE_MIMES.includes(mimeType) || mimeType.startsWith('image/')) {
    return { category: 'image' };
  }
  if (mimeType === 'application/pdf' || ext === '.pdf') {
    return { category: 'pdf' };
  }
  if (mimeType === 'text/html' || ext === '.html' || ext === '.htm') {
    return { category: 'html', language: 'html' };
  }
  if (CODE_EXTENSIONS[ext]) {
    return { category: 'code', language: CODE_EXTENSIONS[ext] };
  }
  if (STYLE_EXTENSIONS[ext]) {
    return { category: 'code', language: STYLE_EXTENSIONS[ext] };
  }
  if (DATA_EXTENSIONS.includes(ext) || mimeType === 'application/json') {
    const lang = ext === '.json' ? 'json' : ext === '.xml' ? 'xml' : ext.slice(1);
    return { category: 'data', language: lang };
  }
  if (TEXT_EXTENSIONS.includes(ext) || mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return { category: 'text', language: ext === '.md' || ext === '.markdown' ? 'markdown' : undefined };
  }
  if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx' ||
      mimeType.includes('officedocument') || mimeType.includes('msword')) {
    return { category: 'document' };
  }
  return { category: 'other' };
}

/**
 * 判断文件是否应该被处理（根据扩展名）
 */
export function shouldProcessFile(fileName: string): boolean {
  const ext = '.' + fileName.split('.').pop()?.toLowerCase();
  return (
    CODE_EXTENSIONS[ext] !== undefined ||
    STYLE_EXTENSIONS[ext] !== undefined ||
    DATA_EXTENSIONS.includes(ext) ||
    TEXT_EXTENSIONS.includes(ext) ||
    ext === '.pdf' || ext === '.html' || ext === '.htm' ||
    ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp'
  );
}

/**
 * 递归读取 FileSystemDirectoryEntry 中的所有文件
 */
export async function readDirectoryEntry(
  dirEntry: FileSystemDirectoryEntry,
  basePath: string = ''
): Promise<File[]> {
  const files: File[] = [];
  const dirReader = dirEntry.createReader();

  const readEntries = (): Promise<FileSystemEntry[]> => {
    return new Promise((resolve, reject) => {
      dirReader.readEntries(resolve, reject);
    });
  };

  const getFile = (fileEntry: FileSystemFileEntry): Promise<File> => {
    return new Promise((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
  };

  try {
    let entries: FileSystemEntry[] = [];
    let batch: FileSystemEntry[];
    do {
      batch = await readEntries();
      entries = entries.concat(batch);
    } while (batch.length > 0);

    for (const entry of entries) {
      const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;
        if (shouldProcessFile(entry.name)) {
          try {
            const file = await getFile(fileEntry);
            Object.defineProperty(file, 'relativePath', { value: fullPath, writable: false });
            files.push(file);
          } catch (err) {
            console.warn(`无法读取文件 ${fullPath}:`, err);
          }
        }
      } else if (entry.isDirectory) {
        if (IGNORED_DIRS.includes(entry.name)) continue;
        const subDirEntry = entry as FileSystemDirectoryEntry;
        const subFiles = await readDirectoryEntry(subDirEntry, fullPath);
        files.push(...subFiles);
      }
    }
  } catch (err) {
    console.error('读取目录失败:', err);
  }
  return files;
}

/**
 * 从 PDF 文件中提取文本内容 - 通过主进程 IPC 处理
 */
export async function extractPdfText(filePath: string): Promise<{ text: string; pageCount: number }> {
  try {
    const result = await window.electronAPI?.extractPdfText(filePath);
    if (result) return result;
    return { text: '[PDF 解析失败: IPC 调用失败]', pageCount: 0 };
  } catch (error) {
    console.error('PDF 文本提取失败:', error);
    return { text: `[PDF 解析失败: ${error instanceof Error ? error.message : '未知错误'}]`, pageCount: 0 };
  }
}

/**
 * 生成唯一的附件 ID
 */
export function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
