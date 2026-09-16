// ============================================================================
// Capture IPC Handlers - 浏览器采集内容 IPC 通道
// ============================================================================

import type { IpcMain } from '../platform';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { CaptureSchemas, type CaptureDomainRequest } from '../../shared/ipc/schemas/capture';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getCaptureService } from '../services/knowledge/captureService';
import { getDocumentContextService } from '../context/documentContext/documentContextService';
import { createLogger } from '../services/infra/logger';
import type { CaptureRequest, CaptureSource } from '@shared/contract/capture';

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

type CaptureRouteCtx = ReturnType<typeof getCaptureService>;

/**
 * capture 域单源路由表（RQ-183 续作·CAPTURE 刀）：原 domain switch 9 个大括号 case 平移为默认模式 handler（case 体原样，
 * `return { success: true, data: X } satisfies IPCResponse<unknown>` 改 `return X`；wechatStatus 内层 try 两个出口都保留）。
 * captureService 仍在注册期取一次，作为装配 ctx 传入。未知 action → UNKNOWN_ACTION + `Unknown action:`（unknownActionCode，文案即
 * 装配器缺省）；抛错进 mapError：原样记 `Capture IPC error` { action, error: message } 日志 + CAPTURE_ERROR（非 Error 为 'Unknown error'）。
 * 请求体为 null / 非对象时原实现在 try 内读 request.action 抛错、catch 里再读 request.action 二次抛错（IPC reject），现返回 UNKNOWN_ACTION。
 */
const captureRoutes = defineDomainRoutes<CaptureDomainRequest, CaptureRouteCtx>(CaptureSchemas.REQUEST, {
  capture: async (service, payload) => {
    const data = payload as CaptureRequest;
    const item = await service.capture(data);
    return item;
  },
  list: async (service, payload) => {
    const opts = payload as { source?: CaptureSource; limit?: number; offset?: number } | undefined;
    const items = service.list(opts);
    return items;
  },
  search: async (service, payload) => {
    const { query, topK } = payload as { query: string; topK?: number };
    const results = await service.search(query, topK);
    return results;
  },
  get: async (service, payload) => {
    const { id } = payload as { id: string };
    const item = service.get(id);
    return item;
  },
  delete: async (service, payload) => {
    const { id } = payload as { id: string };
    const ok = service.delete(id);
    return ok;
  },
  stats: async (service, _payload) => {
    const stats = service.getStats();
    return stats;
  },
  selectFiles: async (_service, _payload) => {
    const { dialog } = await import('../platform');
    const result = await dialog.showOpenDialog({
      title: '选择文件导入到知识库',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持的文件', extensions: ['pdf', 'docx', 'xlsx', 'csv', 'md', 'txt', 'html', 'htm', 'pptx'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  },
  importFiles: async (_service, payload) => {
    const { filePaths } = payload as { filePaths: string[] };
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
    return results;
  },
  wechatStatus: async (_service, _payload) => {
    try {
      const { getWeChatWatcher } = await import('../services/connectors/wechatWatcher');
      const status = getWeChatWatcher().getStatus();
      return status;
    } catch {
      return { watching: false, processedCount: 0 };
    }
  },
}, {
  unknownActionCode: 'UNKNOWN_ACTION',
  mapError: (error, action) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Capture IPC error', { action, error: message });
    return { code: 'CAPTURE_ERROR', message };
  },
});

export function registerCaptureHandlers(ipcMain: IpcMain): void {
  const service = getCaptureService();

  installDomainRoutes(ipcMain, captureRoutes, service);

  logger.info('Capture handlers registered');
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerCaptureHandlers.routes = captureRoutes;

// 导出供 wechatWatcher 复用
export { importLocalFile, SUPPORTED_EXTENSIONS };
