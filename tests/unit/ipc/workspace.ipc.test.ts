import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCreateFile, handleCreateFolder, handleWriteFile } from '../../../src/main/ipc/workspace.ipc';

describe('workspace.ipc create handlers', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'workspace-ipc-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('handleCreateFile', () => {
    it('creates an empty file and returns FileInfo', async () => {
      const filePath = join(workDir, 'a.txt');
      const info = await handleCreateFile({ filePath });
      expect(info.name).toBe('a.txt');
      expect(info.path).toBe(filePath);
      expect(info.isDirectory).toBe(false);
      expect(info.size).toBe(0);
      expect(typeof info.modifiedAt).toBe('number');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('');
    });

    it('writes initial content when provided', async () => {
      const filePath = join(workDir, 'with-content.md');
      const info = await handleCreateFile({ filePath, content: '# hi' });
      expect(info.size).toBe(Buffer.byteLength('# hi', 'utf-8'));
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('# hi');
    });

    it('rejects when the file already exists (wx flag)', async () => {
      const filePath = join(workDir, 'dup.txt');
      await handleCreateFile({ filePath });
      await expect(handleCreateFile({ filePath })).rejects.toThrow();
    });
  });

  describe('handleCreateFolder', () => {
    it('creates a folder and returns FileInfo', async () => {
      const dirPath = join(workDir, 'new-folder');
      const info = await handleCreateFolder({ dirPath });
      expect(info.name).toBe('new-folder');
      expect(info.path).toBe(dirPath);
      expect(info.isDirectory).toBe(true);
      expect(typeof info.modifiedAt).toBe('number');
      const s = await stat(dirPath);
      expect(s.isDirectory()).toBe(true);
    });

    it('rejects when the folder already exists', async () => {
      const dirPath = join(workDir, 'dup-folder');
      await handleCreateFolder({ dirPath });
      await expect(handleCreateFolder({ dirPath })).rejects.toThrow();
    });

    it('rejects when the parent directory does not exist', async () => {
      const dirPath = join(workDir, 'missing', 'child');
      await expect(handleCreateFolder({ dirPath })).rejects.toThrow();
    });
  });

  describe('handleWriteFile', () => {
    it('writes content to a new file and returns metadata', async () => {
      const filePath = join(workDir, 'new.md');
      const content = '# hello\n';
      const result = await handleWriteFile({ filePath, content });
      expect(result.path).toBe(filePath);
      expect(result.size).toBe(Buffer.byteLength(content, 'utf-8'));
      expect(typeof result.modifiedAt).toBe('number');
      expect(await readFile(filePath, 'utf-8')).toBe(content);
    });

    it('overwrites existing content', async () => {
      const filePath = join(workDir, 'existing.md');
      await handleCreateFile({ filePath, content: 'old' });
      const result = await handleWriteFile({ filePath, content: 'new' });
      expect(result.size).toBe(3);
      expect(await readFile(filePath, 'utf-8')).toBe('new');
    });
  });
});
