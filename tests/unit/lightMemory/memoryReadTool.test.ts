// ============================================================================
// Light Memory — memoryReadTool Tests
// Tests reading memory files, validation, and error handling
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

import { memoryReadTool } from '../../../src/main/lightMemory/memoryReadTool';

const mockContext = {
  workingDirectory: '/tmp',
  sessionId: 'test-session',
  conversationId: 'test-conv',
} as any;

describe('memoryReadTool', () => {
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-read-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Tool metadata
  // --------------------------------------------------------------------------

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(memoryReadTool.name).toBe('MemoryRead');
    });

    it('should not require permission', () => {
      expect(memoryReadTool.requiresPermission).toBe(false);
    });

    it('should have filename as required parameter', () => {
      expect(memoryReadTool.inputSchema.required).toContain('filename');
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('should reject filename not ending with .md', async () => {
      const result = await memoryReadTool.execute(
        { filename: 'test.json' },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('.md');
    });

    it('should reject path traversal attempts', async () => {
      const result = await memoryReadTool.execute(
        { filename: '../../etc/passwd.md' },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('path separators');
    });

    it('should reject absolute path in filename', async () => {
      const result = await memoryReadTool.execute(
        { filename: '/tmp/secret.md' },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('path separators');
    });
  });

  // --------------------------------------------------------------------------
  // Reading files
  // --------------------------------------------------------------------------

  describe('reading files', () => {
    it('should read an existing memory file', async () => {
      const content = `---
name: User Role
description: User background info
type: user
---

Product Manager with 14 years of experience.
`;
      await fs.writeFile(path.join(memDir, 'user_role.md'), content, 'utf-8');

      const result = await memoryReadTool.execute(
        { filename: 'user_role.md' },
        mockContext
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Product Manager');
      expect(result.output).toContain('name: User Role');
    });

    it('should return error for non-existent file', async () => {
      const result = await memoryReadTool.execute(
        { filename: 'nonexistent.md' },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.error).toContain('nonexistent.md');
    });

    it('should read file with complex markdown content', async () => {
      const content = `---
name: Project Notes
description: Notes about the project
type: project
---

## Architecture
- Layer 1: Core
- Layer 2: Skills

\`\`\`typescript
const x = 42;
\`\`\`

| Col1 | Col2 |
|------|------|
| A    | B    |
`;
      await fs.writeFile(path.join(memDir, 'project_notes.md'), content, 'utf-8');

      const result = await memoryReadTool.execute(
        { filename: 'project_notes.md' },
        mockContext
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('## Architecture');
      expect(result.output).toContain('const x = 42');
    });
  });
});
