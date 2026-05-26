// ============================================================================
// ChatInput 工具函数 - 文件处理相关
// ============================================================================

import type { AttachmentCategory, MessageAttachment } from '../../../../../shared/contract';
import { createLogger } from '../../../../utils/logger';
import ipcService from '../../../../services/ipcService';

const logger = createLogger('ChatInputUtils');

// ============================================================================
// 文件类型配置
// ============================================================================

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const AUDIO_MIMES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/webm'];
export const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo'];

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
export const EXCEL_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.xlsb'];
export const PRESENTATION_EXTENSIONS = ['.pptx', '.ppt'];
export const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar'];
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm'];
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'];
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const IGNORED_DIRS = ['node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store', 'dist', 'build', '.next', '.cache'];
export const MAX_FOLDER_FILES = 50;

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 只有真正发出去的消息才清空输入框。登录拦截或运行时拒收会返回 false，
 * 此时保留草稿，避免长 prompt 被弹窗吞掉。
 */
export function shouldClearComposerAfterSend(didSend: boolean): boolean {
  return didSend;
}

/**
 * 根据文件信息判断类别
 */
export function getFileCategory(file: File): { category: AttachmentCategory; language?: string } {
  const mimeType = file.type.toLowerCase();
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();

  if (IMAGE_MIMES.includes(mimeType) || mimeType.startsWith('image/')) {
    return { category: 'image' };
  }
  if (AUDIO_MIMES.includes(mimeType) || AUDIO_EXTENSIONS.includes(ext) || mimeType.startsWith('audio/')) {
    return { category: 'audio' };
  }
  if (VIDEO_MIMES.includes(mimeType) || VIDEO_EXTENSIONS.includes(ext) || mimeType.startsWith('video/')) {
    return { category: 'video' };
  }
  if (mimeType === 'application/pdf' || ext === '.pdf') {
    return { category: 'pdf' };
  }
  if (mimeType === 'text/html' || ext === '.html' || ext === '.htm') {
    return { category: 'html', language: 'html' };
  }
  // Excel 文件（支持解析）
  if (EXCEL_EXTENSIONS.includes(ext) ||
      mimeType.includes('spreadsheet') ||
      mimeType === 'application/vnd.ms-excel') {
    return { category: 'excel' };
  }
  if (PRESENTATION_EXTENSIONS.includes(ext) ||
      mimeType.includes('presentation') ||
      mimeType === 'application/vnd.ms-powerpoint') {
    return { category: 'presentation' };
  }
  if (ARCHIVE_EXTENSIONS.includes(ext) ||
      mimeType.includes('zip') ||
      mimeType.includes('gzip') ||
      mimeType.includes('x-tar') ||
      mimeType.includes('x-7z') ||
      mimeType.includes('rar')) {
    return { category: 'archive' };
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
  // 其他 Office 文档（支持 DOCX）
  if (ext === '.docx' ||
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
    EXCEL_EXTENSIONS.includes(ext) ||
    PRESENTATION_EXTENSIONS.includes(ext) ||
    ARCHIVE_EXTENSIONS.includes(ext) ||
    AUDIO_EXTENSIONS.includes(ext) ||
    VIDEO_EXTENSIONS.includes(ext) ||
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
            logger.warn('无法读取文件', { path: fullPath, error: err });
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
    logger.error('读取目录失败', err);
  }
  return files;
}

type ProcessFile = (file: File) => Promise<MessageAttachment | null>;
type ProcessFolderEntry = (
  dirEntry: FileSystemDirectoryEntry,
  folderName: string,
) => Promise<MessageAttachment | null>;

async function attachmentFromEntry(
  entry: FileSystemEntry,
  processFile: ProcessFile,
  processFolderEntry: ProcessFolderEntry,
): Promise<MessageAttachment | null> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
    return processFile(file);
  }

  if (entry.isDirectory) {
    return processFolderEntry(entry as FileSystemDirectoryEntry, entry.name);
  }

  return null;
}

async function attachmentsFromFiles(
  files: FileList | File[],
  processFile: ProcessFile,
): Promise<MessageAttachment[]> {
  const attachments: MessageAttachment[] = [];
  for (const file of Array.from(files)) {
    const attachment = await processFile(file);
    if (attachment) {
      attachments.push(attachment);
    }
  }
  return attachments;
}

/**
 * Browser/Electron drop payloads differ:
 * - real folders need webkitGetAsEntry
 * - screenshots/media dragged from browser surfaces may expose only files
 * - some in-app browser bridges expose DataTransferItemList but no entries
 */
export async function collectDroppedAttachments(
  dataTransfer: DataTransfer,
  processFile: ProcessFile,
  processFolderEntry: ProcessFolderEntry,
): Promise<MessageAttachment[]> {
  const items = dataTransfer.items;
  const entries: FileSystemEntry[] = [];

  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file') {
        continue;
      }
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        entries.push(entry);
      }
    }
  }

  if (entries.length === 0) {
    return attachmentsFromFiles(dataTransfer.files, processFile);
  }

  const attachments: MessageAttachment[] = [];
  for (const entry of entries) {
    const attachment = await attachmentFromEntry(entry, processFile, processFolderEntry);
    if (attachment) {
      attachments.push(attachment);
    }
  }

  return attachments;
}

/**
 * 从 PDF 文件中提取文本内容 - 通过主进程 IPC 处理
 */
export async function extractPdfText(filePath: string): Promise<{ text: string; pageCount: number }> {
  try {
    const result = await ipcService.extractPdfText(filePath);
    if (result) return result;
    return { text: '[PDF 解析失败: IPC 调用失败]', pageCount: 0 };
  } catch (error) {
    logger.error('PDF 文本提取失败', error);
    return { text: `[PDF 解析失败: ${error instanceof Error ? error.message : '未知错误'}]`, pageCount: 0 };
  }
}

/**
 * 生成唯一的附件 ID
 */
export function generateAttachmentId(): string {
  return `att-${Date.now()}-${crypto.randomUUID().split('-')[0]}`;
}
