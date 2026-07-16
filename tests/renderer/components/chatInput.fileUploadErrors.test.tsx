// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const showToast = vi.hoisted(() => vi.fn());
const ipc = vi.hoisted(() => ({
  getPathForFile: vi.fn(),
  extractDocxHtml: vi.fn(),
  extractExcelText: vi.fn(),
  extractExcelJson: vi.fn(),
}));
const readDirectoryEntry = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/stores/uiStore', () => ({
  useUIStore: (selector: (state: { showToast: typeof showToast }) => unknown) => selector({ showToast }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: ipc,
}));
vi.mock('../../../src/renderer/components/features/chat/ChatInput/utils', () => ({
  MAX_FILE_SIZE: 10,
  MAX_FOLDER_FILES: 100,
  generateAttachmentId: () => 'attachment-1',
  extractPdfText: vi.fn(),
  readDirectoryEntry,
  getFileCategory: (file: File) => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    const category = extension === 'docx' || extension === 'doc' ? 'document'
      : extension === 'xlsx' ? 'excel'
        : extension === 'pptx' ? 'presentation'
          : extension === 'zip' ? 'archive'
            : extension === 'png' ? 'image'
              : extension === 'mp3' ? 'audio'
                : extension === 'mp4' ? 'video'
                  : 'code';
    return { category, language: extension };
  },
}));
vi.mock('../../../src/renderer/components/features/chat/ChatInput/attachmentSummaries', () => ({
  buildArchiveManifest: vi.fn(),
  buildPresentationSummary: vi.fn(),
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { useFileUpload } from '../../../src/renderer/components/features/chat/ChatInput/useFileUpload';

class FailingFileReader {
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

  readAsDataURL() {
    this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
  }

  readAsText() {
    this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
  }
}

async function processFile(file: File) {
  const { result } = renderHook(() => useFileUpload());
  let attachment: Awaited<ReturnType<typeof result.current.processFile>>;
  await act(async () => {
    attachment = await result.current.processFile(file);
  });
  return attachment!;
}

describe('useFileUpload failure feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.getPathForFile.mockImplementation(async (file: File) => `/tmp/${file.name}`);
    ipc.extractDocxHtml.mockResolvedValue(null);
    ipc.extractExcelText.mockResolvedValue(null);
    readDirectoryEntry.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Word 解析失败时说明文件名、原因和建议', async () => {
    expect(await processFile(new File(['x'], 'report.docx'))).toBeNull();
    expect(showToast).toHaveBeenCalledWith(
      'error',
      '文件 "report.docx" 处理失败：无法解析 Word 文档。请确认文件未损坏后重试',
    );
  });

  it('Excel 解析失败时说明文件名、原因和建议', async () => {
    expect(await processFile(new File(['x'], 'budget.xlsx'))).toBeNull();
    expect(showToast).toHaveBeenCalledWith(
      'error',
      '文件 "budget.xlsx" 处理失败：无法解析 Excel 文件。请确认文件未损坏后重试',
    );
  });

  it.each([
    ['slides.pptx', '演示文稿'],
    ['source.zip', '压缩包'],
    ['photo.png', '图片'],
    ['voice.mp3', '音频'],
    ['movie.mp4', '视频'],
    ['notes.txt', '文本文件'],
  ])('%s 读取失败时说明文件名、原因和建议', async (fileName, kind) => {
    vi.stubGlobal('FileReader', FailingFileReader);

    expect(await processFile(new File(['x'], fileName))).toBeNull();
    expect(showToast).toHaveBeenCalledWith(
      'error',
      `文件 "${fileName}" 读取失败：无法读取${kind}内容。请检查文件是否损坏或重新选择`,
    );
  });

  it('旧版 Office 文档格式不支持时给出转换建议', async () => {
    expect(await processFile(new File(['x'], 'legacy.doc'))).toBeNull();
    expect(showToast).toHaveBeenCalledWith(
      'warning',
      '文件 "legacy.doc" 格式暂不支持。请转换为 DOCX 或 PDF 后重试',
    );
  });

  it('空文件夹说明原因和下一步', async () => {
    const { result } = renderHook(() => useFileUpload());
    let attachment: Awaited<ReturnType<typeof result.current.processFolderEntry>>;
    await act(async () => {
      attachment = await result.current.processFolderEntry({} as FileSystemDirectoryEntry, 'empty-folder');
    });

    expect(attachment!).toBeNull();
    expect(showToast).toHaveBeenCalledWith(
      'warning',
      '文件夹 "empty-folder" 中没有可处理的文件。请选择包含可读文件的文件夹',
    );
  });

  it('已提示过的超限分支不会重复 toast', async () => {
    const file = new File(['x'], 'large.txt');
    Object.defineProperty(file, 'size', { value: 11 });

    expect(await processFile(file)).toBeNull();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('warning', '文件 "large.txt" 太大（11B），最大支持 10MB');
  });
});
