// ============================================================================
// Local pdftotext extraction — shared by read_pdf and library ingest.
// Kept off the ToolModule barrel so library code does not import getConfigService.
// ============================================================================

import { execFile } from 'node:child_process';
import { NETWORK_TOOL_TIMEOUTS } from '../../../../shared/constants';
import { TOOL_DEPENDENCY_HINTS } from '../_helpers/dependencyHints';

export interface PdfTextExtractLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

function isAbortLike(error: unknown, abortSignal: AbortSignal): boolean {
  if (abortSignal.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  const name = (error as { name?: string }).name;
  return code === 'ABORT_ERR' || code === 'ABORTED' || name === 'AbortError';
}

function isMissingBinary(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  const rawMessage = (error as { message?: unknown }).message;
  const message = typeof rawMessage === 'string'
    ? rawMessage
    : error instanceof Error
      ? error.message
      : String(error);
  return code === 'ENOENT' || /\bENOENT\b/.test(message) || /not found/i.test(message);
}

function runPdftotext(bin: string, filePath: string, abortSignal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (abortSignal.aborted) {
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      return;
    }
    execFile(
      bin,
      ['-layout', filePath, '-'],
      {
        maxBuffer: 50 * 1024 * 1024,
        timeout: NETWORK_TOOL_TIMEOUTS.PDF_TEXT_EXTRACT,
        signal: abortSignal,
      },
      (error, stdout, stderr) => {
        if (isAbortLike(error, abortSignal)) {
          reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
          return;
        }
        if (error) {
          const execError = error as NodeJS.ErrnoException & { killed?: boolean };
          if (execError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(Object.assign(new Error('pdftotext output exceeded maxBuffer'), { code: 'MAXBUFFER' }));
            return;
          }
          if (execError.killed) {
            reject(Object.assign(new Error('pdftotext timed out'), { code: 'TIMEOUT' }));
            return;
          }
          const detail = String(stderr ?? '').trim();
          if (detail) execError.message = `${execError.message}: ${detail}`.slice(0, 500);
          reject(execError);
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? ''));
      },
    );
  });
}

export async function extractSelectablePdfText(
  filePath: string,
  abortSignal: AbortSignal,
  logger: PdfTextExtractLogger,
): Promise<string> {
  const bins = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', 'pdftotext'];
  const attempts: Array<{ bin: string; code?: string; message: string }> = [];
  for (const bin of bins) {
    if (abortSignal.aborted) {
      throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
    try {
      const stdout = await runPdftotext(bin, filePath, abortSignal);
      if (stdout.trim()) return stdout;
      attempts.push({ bin, message: 'empty text' });
      logger.warn('pdftotext candidate returned empty text', { bin });
    } catch (error) {
      if (isAbortLike(error, abortSignal)) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
      }
      const code = (error as { code?: string }).code;
      if (code === 'TIMEOUT' || code === 'MAXBUFFER') {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ bin, code, message });
      logger.warn('pdftotext candidate failed', { bin, code, message });
    }
  }
  const lastReal = [...attempts].reverse().find((attempt) => !isMissingBinary(attempt));
  const detail = lastReal
    ? `${lastReal.bin}: ${lastReal.message}`
    : '未安装 poppler。安装：brew install poppler';
  throw new Error(`${TOOL_DEPENDENCY_HINTS.readPdfOpenRouter} 本地 pdftotext 失败：${detail}`);
}
