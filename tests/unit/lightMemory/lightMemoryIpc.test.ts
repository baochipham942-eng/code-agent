// ============================================================================
// Light Memory — lightMemoryIpc Tests
// Tests IPC service: list, read, delete, stats, and frontmatter parsing
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => {
  return { dir: '' };
});

vi.mock('../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  listMemoryFiles,
  readMemoryFile,
  deleteMemoryFile,
  getLightMemoryStats,
} from '../../../src/main/lightMemory/lightMemoryIpc';

describe('lightMemoryIpc', () => {
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-ipc-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Helper: write a memory file with frontmatter
  async function writeMemoryFile(
    filename: string,
    meta: { name: string; description: string; type: string },
    body: string
  ) {
    const content = `---
name: ${meta.name}
description: ${meta.description}
type: ${meta.type}
---

${body}
`;
    await fs.writeFile(path.join(memDir, filename), content, 'utf-8');
  }

  // --------------------------------------------------------------------------
  // listMemoryFiles
  // --------------------------------------------------------------------------

  describe('listMemoryFiles', () => {
    it('should return empty array when no memory files exist', async () => {
      const files = await listMemoryFiles();
      expect(files).toEqual([]);
    });

    it('should return empty array when memory dir does not exist', async () => {
      await fs.rm(memDir, { recursive: true, force: true });
      const files = await listMemoryFiles();
      expect(files).toEqual([]);
    });

    it('should list memory files with parsed frontmatter', async () => {
      await writeMemoryFile('user_role.md', {
        name: 'User Role',
        description: 'Background info',
        type: 'user',
      }, 'Product Manager');

      const files = await listMemoryFiles();
      expect(files.length).toBe(1);
      expect(files[0].filename).toBe('user_role.md');
      expect(files[0].name).toBe('User Role');
      expect(files[0].description).toBe('Background info');
      expect(files[0].type).toBe('user');
      expect(files[0].content).toBe('Product Manager');
      expect(files[0].updatedAt).toBeTruthy();
    });

    it('should exclude INDEX.md from listing', async () => {
      await fs.writeFile(path.join(memDir, 'INDEX.md'), '# Memory Index\n', 'utf-8');
      await writeMemoryFile('project_notes.md', {
        name: 'Notes',
        description: 'Project notes',
        type: 'project',
      }, 'Some notes');

      const files = await listMemoryFiles();
      expect(files.length).toBe(1);
      expect(files[0].filename).toBe('project_notes.md');
    });

    it('should exclude non-.md files', async () => {
      await fs.writeFile(path.join(memDir, 'session-stats.json'), '{}', 'utf-8');
      await writeMemoryFile('valid.md', {
        name: 'Valid',
        description: 'Valid file',
        type: 'user',
      }, 'content');

      const files = await listMemoryFiles();
      expect(files.length).toBe(1);
      expect(files[0].filename).toBe('valid.md');
    });

    it('should sort by modification time (newest first)', async () => {
      await writeMemoryFile('older.md', {
        name: 'Older',
        description: 'Older file',
        type: 'user',
      }, 'old');

      // Wait a bit to ensure different mtime
      await new Promise(resolve => setTimeout(resolve, 50));

      await writeMemoryFile('newer.md', {
        name: 'Newer',
        description: 'Newer file',
        type: 'user',
      }, 'new');

      const files = await listMemoryFiles();
      expect(files.length).toBe(2);
      expect(files[0].filename).toBe('newer.md');
      expect(files[1].filename).toBe('older.md');
    });

    it('should handle files without frontmatter gracefully', async () => {
      await fs.writeFile(path.join(memDir, 'no_frontmatter.md'), 'Just plain markdown', 'utf-8');

      const files = await listMemoryFiles();
      expect(files.length).toBe(1);
      expect(files[0].name).toBe('no_frontmatter'); // fallback name
      expect(files[0].type).toBe('unknown');
    });
  });

  // --------------------------------------------------------------------------
  // readMemoryFile
  // --------------------------------------------------------------------------

  describe('readMemoryFile', () => {
    it('should read a single memory file with parsed frontmatter', async () => {
      await writeMemoryFile('test_read.md', {
        name: 'Test Read',
        description: 'Testing read',
        type: 'reference',
      }, 'Reference content here');

      const file = await readMemoryFile('test_read.md');
      expect(file).not.toBeNull();
      expect(file!.filename).toBe('test_read.md');
      expect(file!.name).toBe('Test Read');
      expect(file!.type).toBe('reference');
      expect(file!.content).toBe('Reference content here');
    });

    it('should return null for non-existent file', async () => {
      const file = await readMemoryFile('nonexistent.md');
      expect(file).toBeNull();
    });

    it('should sanitize path traversal in filename', async () => {
      // path.basename('../../hack.md') = 'hack.md'
      // So it looks for 'hack.md' in the memory dir, which doesn't exist
      const file = await readMemoryFile('../../hack.md');
      expect(file).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // deleteMemoryFile
  // --------------------------------------------------------------------------

  describe('deleteMemoryFile', () => {
    it('should delete an existing memory file', async () => {
      await writeMemoryFile('to_delete.md', {
        name: 'Delete',
        description: 'To be deleted',
        type: 'feedback',
      }, 'Temporary');

      const result = await deleteMemoryFile('to_delete.md');
      expect(result).toBe(true);

      // Verify file is gone
      const exists = await fs.stat(path.join(memDir, 'to_delete.md')).then(() => true, () => false);
      expect(exists).toBe(false);
    });

    it('should remove entry from INDEX.md', async () => {
      // Create INDEX.md with two entries
      await fs.writeFile(path.join(memDir, 'INDEX.md'),
        '# Memory Index\n\n- [keep.md](keep.md) — Keep this\n- [remove.md](remove.md) — Remove this\n',
        'utf-8'
      );
      await writeMemoryFile('remove.md', {
        name: 'Remove',
        description: 'Remove this',
        type: 'user',
      }, 'content');

      await deleteMemoryFile('remove.md');

      const indexContent = await fs.readFile(path.join(memDir, 'INDEX.md'), 'utf-8');
      expect(indexContent).toContain('[keep.md]');
      expect(indexContent).not.toContain('[remove.md]');
    });

    it('should return true even for non-existent file (ENOENT)', async () => {
      const result = await deleteMemoryFile('nonexistent.md');
      expect(result).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getLightMemoryStats
  // --------------------------------------------------------------------------

  describe('getLightMemoryStats', () => {
    it('should return zero stats when memory dir is empty', async () => {
      const stats = await getLightMemoryStats();
      expect(stats.totalFiles).toBe(0);
      expect(stats.byType).toEqual({});
      expect(stats.sessionStats).toBeNull();
      expect(stats.recentConversations).toEqual([]);
    });

    it('should count files by type', async () => {
      await writeMemoryFile('user1.md', { name: 'U1', description: 'd', type: 'user' }, 'c');
      await writeMemoryFile('user2.md', { name: 'U2', description: 'd', type: 'user' }, 'c');
      await writeMemoryFile('proj1.md', { name: 'P1', description: 'd', type: 'project' }, 'c');

      const stats = await getLightMemoryStats();
      expect(stats.totalFiles).toBe(3);
      expect(stats.byType['user']).toBe(2);
      expect(stats.byType['project']).toBe(1);
    });

    it('should include session stats when available', async () => {
      const sessionData = {
        activeDays: ['2026-03-19'],
        totalSessions: 5,
        recentSessionDepths: [10, 15, 20],
        modelUsage: { 'kimi-k2.5': 3 },
      };
      await fs.writeFile(
        path.join(memDir, 'session-stats.json'),
        JSON.stringify(sessionData),
        'utf-8'
      );

      const stats = await getLightMemoryStats();
      expect(stats.sessionStats).not.toBeNull();
      expect(stats.sessionStats!.totalSessions).toBe(5);
      expect(stats.sessionStats!.modelUsage['kimi-k2.5']).toBe(3);
    });

    it('should include recent conversations when available', async () => {
      const conversations = `# Recent Conversations

- **2026-03-18**: "Chatbot dev" — prompt engineering, tool use
- **2026-03-19**: "Testing" — vitest, coverage
`;
      await fs.writeFile(path.join(memDir, 'recent-conversations.md'), conversations, 'utf-8');

      const stats = await getLightMemoryStats();
      expect(stats.recentConversations.length).toBe(2);
      expect(stats.recentConversations[0]).toContain('Chatbot dev');
      expect(stats.recentConversations[1]).toContain('Testing');
    });
  });
});
