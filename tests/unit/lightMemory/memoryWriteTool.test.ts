// ============================================================================
// Light Memory — memoryWriteTool Tests
// Tests write, delete, validation, and INDEX.md auto-maintenance
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

import { memoryWriteTool } from '../../../src/main/lightMemory/memoryWriteTool';

// Minimal mock context
const mockContext = {
  workingDirectory: '/tmp',
  sessionId: 'test-session',
  conversationId: 'test-conv',
} as any;

describe('memoryWriteTool', () => {
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-write-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Tool metadata
  // --------------------------------------------------------------------------

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(memoryWriteTool.name).toBe('MemoryWrite');
    });

    it('should not require permission', () => {
      expect(memoryWriteTool.requiresPermission).toBe(false);
    });

    it('should have inputSchema with required action and filename', () => {
      expect(memoryWriteTool.inputSchema.required).toContain('action');
      expect(memoryWriteTool.inputSchema.required).toContain('filename');
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('should reject filename not ending with .md', async () => {
      const result = await memoryWriteTool.execute(
        { action: 'write', filename: 'test.txt' },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('.md');
    });

    it('should reject filename with path separators', async () => {
      const result = await memoryWriteTool.execute(
        { action: 'write', filename: '../etc/passwd.md' },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('path separators');
    });

    it('should reject unknown action', async () => {
      const result = await memoryWriteTool.execute(
        { action: 'update', filename: 'test.md' },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
    });

    it('should reject write with missing name', async () => {
      const result = await memoryWriteTool.execute(
        {
          action: 'write',
          filename: 'test.md',
          description: 'desc',
          type: 'user',
          content: 'content',
        },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('name, description, type, content');
    });

    it('should reject write with missing content', async () => {
      const result = await memoryWriteTool.execute(
        {
          action: 'write',
          filename: 'test.md',
          name: 'Test',
          description: 'desc',
          type: 'user',
        },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('name, description, type, content');
    });

    it('should reject invalid memory type', async () => {
      const result = await memoryWriteTool.execute(
        {
          action: 'write',
          filename: 'test.md',
          name: 'Test',
          description: 'desc',
          type: 'invalid',
          content: 'content',
        },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid type');
    });
  });

  // --------------------------------------------------------------------------
  // Write action
  // --------------------------------------------------------------------------

  describe('write action', () => {
    it('should create a memory file with frontmatter', async () => {
      const result = await memoryWriteTool.execute(
        {
          action: 'write',
          filename: 'user_role.md',
          name: 'User Role',
          description: 'User role and background',
          type: 'user',
          content: 'Product Manager with 14 years experience',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('user_role.md');

      // Verify file content
      const fileContent = await fs.readFile(path.join(memDir, 'user_role.md'), 'utf-8');
      expect(fileContent).toContain('---');
      expect(fileContent).toContain('name: User Role');
      expect(fileContent).toContain('description: User role and background');
      expect(fileContent).toContain('type: user');
      expect(fileContent).toContain('Product Manager with 14 years experience');
    });

    it('should create INDEX.md on first write', async () => {
      await memoryWriteTool.execute(
        {
          action: 'write',
          filename: 'first_memory.md',
          name: 'First',
          description: 'First memory entry',
          type: 'project',
          content: 'Hello world',
        },
        mockContext
      );

      const indexContent = await fs.readFile(path.join(memDir, 'INDEX.md'), 'utf-8');
      expect(indexContent).toContain('[first_memory.md]');
      expect(indexContent).toContain('First memory entry');
    });

    it('should update INDEX.md entry on overwrite', async () => {
      // First write
      await memoryWriteTool.execute(
        {
          action: 'write',
          filename: 'evolving.md',
          name: 'Evolving',
          description: 'Original description',
          type: 'project',
          content: 'Version 1',
        },
        mockContext
      );

      // Second write — same filename, different description
      await memoryWriteTool.execute(
        {
          action: 'write',
          filename: 'evolving.md',
          name: 'Evolving',
          description: 'Updated description',
          type: 'project',
          content: 'Version 2',
        },
        mockContext
      );

      const indexContent = await fs.readFile(path.join(memDir, 'INDEX.md'), 'utf-8');
      // Should contain the updated description, not the old one
      expect(indexContent).toContain('Updated description');
      // Should not have duplicate entries
      const entries = indexContent.split('\n').filter((l: string) => l.includes('[evolving.md]'));
      expect(entries.length).toBe(1);
    });

    it('should accept all four valid types', async () => {
      const types = ['user', 'feedback', 'project', 'reference'] as const;

      for (const type of types) {
        const result = await memoryWriteTool.execute(
          {
            action: 'write',
            filename: `${type}_test.md`,
            name: `${type} test`,
            description: `Testing ${type} type`,
            type,
            content: `Content for ${type}`,
          },
          mockContext
        );
        expect(result.success).toBe(true);
      }

      // All four entries in INDEX.md
      const indexContent = await fs.readFile(path.join(memDir, 'INDEX.md'), 'utf-8');
      for (const type of types) {
        expect(indexContent).toContain(`[${type}_test.md]`);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Delete action
  // --------------------------------------------------------------------------

  describe('delete action', () => {
    it('should delete an existing memory file', async () => {
      // Create a file first
      await memoryWriteTool.execute(
        {
          action: 'write',
          filename: 'to_delete.md',
          name: 'Delete Me',
          description: 'Will be deleted',
          type: 'feedback',
          content: 'Temporary',
        },
        mockContext
      );

      // Verify it exists
      const exists = await fs.stat(path.join(memDir, 'to_delete.md')).then(() => true, () => false);
      expect(exists).toBe(true);

      // Delete
      const result = await memoryWriteTool.execute(
        { action: 'delete', filename: 'to_delete.md' },
        mockContext
      );
      expect(result.success).toBe(true);

      // Verify file is gone
      const existsAfter = await fs.stat(path.join(memDir, 'to_delete.md')).then(() => true, () => false);
      expect(existsAfter).toBe(false);
    });

    it('should remove entry from INDEX.md on delete', async () => {
      // Create two files
      await memoryWriteTool.execute(
        {
          action: 'write',
          filename: 'keep.md',
          name: 'Keep',
          description: 'Keep this',
          type: 'user',
          content: 'Staying',
        },
        mockContext
      );
      await memoryWriteTool.execute(
        {
          action: 'write',
          filename: 'remove.md',
          name: 'Remove',
          description: 'Remove this',
          type: 'user',
          content: 'Going away',
        },
        mockContext
      );

      // Delete one
      await memoryWriteTool.execute(
        { action: 'delete', filename: 'remove.md' },
        mockContext
      );

      const indexContent = await fs.readFile(path.join(memDir, 'INDEX.md'), 'utf-8');
      expect(indexContent).toContain('[keep.md]');
      expect(indexContent).not.toContain('[remove.md]');
    });

    it('should succeed even if file does not exist (idempotent)', async () => {
      // Ensure memory dir exists with an INDEX.md
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(path.join(memDir, 'INDEX.md'), '# Memory Index\n', 'utf-8');

      const result = await memoryWriteTool.execute(
        { action: 'delete', filename: 'nonexistent.md' },
        mockContext
      );
      expect(result.success).toBe(true);
    });
  });
});
