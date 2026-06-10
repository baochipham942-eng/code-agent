// ============================================================================
// workspaceSaveExport - 会话导出主进程直写「下载」文件夹
// 覆盖：内容落盘、fileName 路径分隔符清洗（防穿越）、重名 -N 后缀、空名兜底
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { handleSaveTextToDownloads } from '../../../src/main/ipc/workspaceSaveExport';

let fakeHome: string;

beforeEach(async () => {
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'save-export-'));
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(fakeHome, { recursive: true, force: true });
});

describe('handleSaveTextToDownloads', () => {
  it('writes content into the Downloads folder and returns the file path', async () => {
    const { filePath } = await handleSaveTextToDownloads({
      fileName: 'session-log-abc.json',
      content: '{"ok":true}',
    });

    expect(filePath).toBe(path.join(fakeHome, 'Downloads', 'session-log-abc.json'));
    expect(await fs.readFile(filePath, 'utf-8')).toBe('{"ok":true}');
  });

  it('strips path separators from the file name to prevent traversal', async () => {
    const { filePath } = await handleSaveTextToDownloads({
      fileName: '../../etc/passwd',
      content: 'x',
    });

    expect(path.dirname(filePath)).toBe(path.join(fakeHome, 'Downloads'));
    expect(path.basename(filePath)).toBe('.._.._etc_passwd');
  });

  it('appends -N suffix instead of overwriting an existing export', async () => {
    const first = await handleSaveTextToDownloads({ fileName: 'session.md', content: 'one' });
    const second = await handleSaveTextToDownloads({ fileName: 'session.md', content: 'two' });
    const third = await handleSaveTextToDownloads({ fileName: 'session.md', content: 'three' });

    expect(path.basename(first.filePath)).toBe('session.md');
    expect(path.basename(second.filePath)).toBe('session-1.md');
    expect(path.basename(third.filePath)).toBe('session-2.md');
    expect(await fs.readFile(first.filePath, 'utf-8')).toBe('one');
    expect(await fs.readFile(second.filePath, 'utf-8')).toBe('two');
  });

  it('falls back to export.txt when the file name is empty', async () => {
    const { filePath } = await handleSaveTextToDownloads({ fileName: '', content: 'x' });
    expect(path.basename(filePath)).toBe('export.txt');
  });
});
