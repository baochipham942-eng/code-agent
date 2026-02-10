// ============================================================================
// Capture IPC Handlers - 浏览器采集内容 IPC 通道
// ============================================================================

import type { IpcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '@shared/ipc';
import { getCaptureService } from '../services/captureService';
import { getDocumentContextService } from '../context/documentContext/documentContextService';
import { createLogger } from '../services/infra/logger';
import type { CaptureRequest, CaptureSource } from '@shared/types/capture';

const logger = createLogger('CaptureIPC');

// 支持导入的文件扩展名
const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.xlsx', '.csv', '.md',
  '.txt', '.html', '.htm', '.pptx',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
]);

// 纯二进制格式：parser 无法直接 toString('utf-8')
const BINARY_FORMATS = new Set(['.pdf', '.pptx']);

/**
 * 尝试用系统 pdftotext 提取 PDF 文本
 */
function extractPdfText(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('pdftotext', [filePath, '-'], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout?.trim()) {
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * 导入本地文件到知识库
 */
async function importLocalFile(filePath: string): Promise<void> {
  const service = getCaptureService();
  const docService = getDocumentContextService();
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  // 读取文件
  const stat = await fs.promises.stat(filePath);

  let content: string;

  if (ext === '.pdf') {
    // PDF：用系统 pdftotext 提取，失败则占位
    const text = await extractPdfText(filePath);
    content = text || `[PDF: ${basename}] (${stat.size} bytes，需安装 pdftotext: brew install poppler)`;
  } else if (BINARY_FORMATS.has(ext)) {
    // PPTX 等其他纯二进制格式：占位
    content = `[File: ${basename}] (${ext} format, ${stat.size} bytes)`;
  } else {
    // 文本类格式：用解析器或直接读取
    const buffer = await fs.promises.readFile(filePath);

    if (docService.canParse(filePath)) {
      const doc = await docService.parse(buffer, filePath);
      if (doc) {
        content = doc.sections.map(s => s.content).join('\n\n');
      } else {
        content = buffer.toString('utf-8');
      }
    } else {
      content = buffer.toString('utf-8');
    }
  }

  await service.capture({
    title: basename,
    content,
    source: 'local_file',
    metadata: {
      filePath,
      fileSize: stat.size,
      fileExt: ext,
    },
  });
}

export function registerCaptureHandlers(ipcMain: IpcMain): void {
  const service = getCaptureService();

  ipcMain.handle(IPC_DOMAINS.CAPTURE, async (_event, request: IPCRequest) => {
    try {
      switch (request.action) {
        case 'capture': {
          const data = request.payload as CaptureRequest;
          const item = await service.capture(data);
          return { success: true, data: item } satisfies IPCResponse<unknown>;
        }

        case 'list': {
          const opts = request.payload as { source?: CaptureSource; limit?: number; offset?: number } | undefined;
          const items = service.list(opts);
          return { success: true, data: items } satisfies IPCResponse<unknown>;
        }

        case 'search': {
          const { query, topK } = request.payload as { query: string; topK?: number };
          const results = await service.search(query, topK);
          return { success: true, data: results } satisfies IPCResponse<unknown>;
        }

        case 'get': {
          const { id } = request.payload as { id: string };
          const item = service.get(id);
          return { success: true, data: item } satisfies IPCResponse<unknown>;
        }

        case 'delete': {
          const { id } = request.payload as { id: string };
          const ok = service.delete(id);
          return { success: true, data: ok } satisfies IPCResponse<unknown>;
        }

        case 'stats': {
          const stats = service.getStats();
          return { success: true, data: stats } satisfies IPCResponse<unknown>;
        }

        case 'selectFiles': {
          const { dialog } = await import('electron');
          const result = await dialog.showOpenDialog({
            title: '选择文件导入到知识库',
            properties: ['openFile', 'multiSelections'],
            filters: [
              { name: '支持的文件', extensions: ['pdf', 'docx', 'xlsx', 'csv', 'md', 'txt', 'html', 'htm', 'pptx'] },
              { name: '所有文件', extensions: ['*'] },
            ],
          });
          return { success: true, data: result.canceled ? [] : result.filePaths } satisfies IPCResponse<unknown>;
        }

        case 'importFiles': {
          const { filePaths } = request.payload as { filePaths: string[] };
          const results: Array<{ path: string; success: boolean; error?: string }> = [];
          for (const fp of filePaths) {
            try {
              const ext = path.extname(fp).toLowerCase();
              if (!SUPPORTED_EXTENSIONS.has(ext)) {
                results.push({ path: fp, success: false, error: `不支持的文件格式: ${ext}` });
                continue;
              }
              await importLocalFile(fp);
              results.push({ path: fp, success: true });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              results.push({ path: fp, success: false, error: msg });
              logger.error('Failed to import file', { path: fp, error: msg });
            }
          }
          return { success: true, data: results } satisfies IPCResponse<unknown>;
        }

        case 'wechatStatus': {
          try {
            const { getWeChatWatcher } = await import('../services/wechatWatcher');
            const status = getWeChatWatcher().getStatus();
            return { success: true, data: status } satisfies IPCResponse<unknown>;
          } catch {
            return { success: true, data: { watching: false, processedCount: 0 } } satisfies IPCResponse<unknown>;
          }
        }

        default:
          return { success: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown action: ${request.action}` } } satisfies IPCResponse<unknown>;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Capture IPC error', { action: request.action, error: message });
      return { success: false, error: { code: 'CAPTURE_ERROR', message } } satisfies IPCResponse<unknown>;
    }
  });

  logger.info('Capture handlers registered');
}

// 导出供 wechatWatcher 复用
export { importLocalFile, SUPPORTED_EXTENSIONS };
