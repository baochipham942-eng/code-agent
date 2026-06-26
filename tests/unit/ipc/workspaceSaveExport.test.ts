// ============================================================================
// workspaceSaveExport - 会话导出主进程直写「下载」文件夹
// 覆盖：内容落盘、fileName 路径分隔符清洗（防穿越）、重名 -N 后缀、空名兜底
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { handleSaveTextToDownloads, handleSaveBinaryToDownloads } from '../../../src/host/ipc/workspaceSaveExport';

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

describe('handleSaveBinaryToDownloads', () => {
  it('decodes base64 to exact bytes (no utf-8 corruption) in the Downloads folder', async () => {
    const original = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe]); // %PDF- + binary
    const { filePath } = await handleSaveBinaryToDownloads({
      fileName: 'doc.pdf',
      base64: original.toString('base64'),
    });

    expect(filePath).toBe(path.join(fakeHome, 'Downloads', 'doc.pdf'));
    const written = await fs.readFile(filePath);
    expect(written.equals(original)).toBe(true);
  });

  it('appends -N suffix instead of overwriting an existing binary export', async () => {
    const a = Buffer.from('one').toString('base64');
    const b = Buffer.from('two').toString('base64');
    const first = await handleSaveBinaryToDownloads({ fileName: 'design.pdf', base64: a });
    const second = await handleSaveBinaryToDownloads({ fileName: 'design.pdf', base64: b });

    expect(path.basename(first.filePath)).toBe('design.pdf');
    expect(path.basename(second.filePath)).toBe('design-1.pdf');
    expect((await fs.readFile(second.filePath)).toString()).toBe('two');
  });

  it('strips path separators from the file name to prevent traversal', async () => {
    const { filePath } = await handleSaveBinaryToDownloads({
      fileName: '../../etc/evil.pdf',
      base64: Buffer.from('x').toString('base64'),
    });
    expect(path.dirname(filePath)).toBe(path.join(fakeHome, 'Downloads'));
    expect(path.basename(filePath)).toBe('.._.._etc_evil.pdf');
  });

  it('falls back to export.bin when the file name is empty', async () => {
    const { filePath } = await handleSaveBinaryToDownloads({
      fileName: '',
      base64: Buffer.from('x').toString('base64'),
    });
    expect(path.basename(filePath)).toBe('export.bin');
  });
});
