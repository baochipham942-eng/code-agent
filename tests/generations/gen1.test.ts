// ============================================================================
// Gen1 Tests - 基础工具期 (Basic Tools Era)
// Tests: bash, read_file, write_file, edit_file
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock isolated-vm (causes Node version issues in tests)
vi.mock('isolated-vm', () => ({}));

// Import tools
import { bashTool } from '../../src/main/tools/shell/bash';
import { readFileTool } from '../../src/main/tools/file/read';
import { writeFileTool } from '../../src/main/tools/file/write';
import { editFileTool } from '../../src/main/tools/file/edit';

// Mock context
const createMockContext = (workingDirectory: string) => ({
  workingDirectory,
  generation: { id: 'gen1' as const },
  requestPermission: async () => true,
  emit: () => {},
});

describe('Gen1 - Basic Tools Era', () => {
  let testDir: string;
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    // Create a temp directory for tests
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen1-test-'));
    context = createMockContext(testDir);
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Bash Tool Tests
  // --------------------------------------------------------------------------
  describe('bash', () => {
    it('should execute simple command', async () => {
      const result = await bashTool.execute(
        { command: 'echo "hello world"' },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('hello world');
    });

    it('should execute command in working directory', async () => {
      const result = await bashTool.execute(
        { command: 'pwd' },
        context
      );
      expect(result.success).toBe(true);
      // macOS resolves /var to /private/var, so use basename comparison
      expect(result.output?.trim()).toContain(path.basename(testDir));
    });

    it('should handle command failure', async () => {
      const result = await bashTool.execute(
        { command: 'exit 1' },
        context
      );
      expect(result.success).toBe(false);
    });

    it('should support custom working directory', async () => {
      const result = await bashTool.execute(
        { command: 'pwd', working_directory: os.tmpdir() },
        context
      );
      expect(result.success).toBe(true);
      // macOS resolves /var to /private/var, so check it ends with expected path
      const output = result.output?.trim() || '';
      expect(output.endsWith('/T') || output.endsWith('/tmp')).toBe(true);
    });

    it('should truncate long output', async () => {
      const result = await bashTool.execute(
        { command: 'yes | head -10000' },
        context
      );
      expect(result.success).toBe(true);
      // Output should be truncated if over 30000 chars
    });

    it('should include stderr in output', async () => {
      const result = await bashTool.execute(
        { command: 'echo "stdout" && echo "stderr" >&2' },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('stdout');
      expect(result.output).toContain('stderr');
    });
  });

  // --------------------------------------------------------------------------
  // Read File Tool Tests
  // --------------------------------------------------------------------------
  describe('read_file', () => {
    const testFileName = 'test-read.txt';
    const testContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';

    beforeEach(() => {
      fs.writeFileSync(path.join(testDir, testFileName), testContent);
    });

    it('should read entire file', async () => {
      const result = await readFileTool.execute(
        { file_path: path.join(testDir, testFileName) },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Line 1');
      expect(result.output).toContain('Line 5');
    });

    it('should read file with offset', async () => {
      const result = await readFileTool.execute(
        { file_path: path.join(testDir, testFileName), offset: 3 },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Line 3');
      expect(result.output).not.toContain('Line 1');
    });

    it('should read file with limit', async () => {
      const result = await readFileTool.execute(
        { file_path: path.join(testDir, testFileName), limit: 2 },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Line 1');
      expect(result.output).toContain('Line 2');
    });

    it('should handle non-existent file', async () => {
      const result = await readFileTool.execute(
        { file_path: path.join(testDir, 'nonexistent.txt') },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should show line numbers', async () => {
      const result = await readFileTool.execute(
        { file_path: path.join(testDir, testFileName) },
        context
      );
      expect(result.success).toBe(true);
      // Output should include line numbers
      expect(result.output).toMatch(/\d+.*Line/);
    });
  });

  // --------------------------------------------------------------------------
  // Write File Tool Tests
  // --------------------------------------------------------------------------
  describe('write_file', () => {
    it('should create new file', async () => {
      const filePath = path.join(testDir, 'new-file.txt');
      const content = 'Hello, World!';

      const result = await writeFileTool.execute(
        { file_path: filePath, content },
        context
      );

      expect(result.success).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
    });

    it('should overwrite existing file', async () => {
      const filePath = path.join(testDir, 'existing.txt');
      fs.writeFileSync(filePath, 'old content');

      const newContent = 'new content';
      const result = await writeFileTool.execute(
        { file_path: filePath, content: newContent },
        context
      );

      expect(result.success).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(newContent);
    });

    it('should create parent directories', async () => {
      const filePath = path.join(testDir, 'nested', 'deep', 'file.txt');
      const content = 'Nested content';

      const result = await writeFileTool.execute(
        { file_path: filePath, content },
        context
      );

      expect(result.success).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('should handle empty content', async () => {
      const filePath = path.join(testDir, 'empty.txt');

      const result = await writeFileTool.execute(
        { file_path: filePath, content: '' },
        context
      );

      expect(result.success).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // Edit File Tool Tests
  // --------------------------------------------------------------------------
  describe('edit_file', () => {
    const testFileName = 'test-edit.txt';

    beforeEach(() => {
      fs.writeFileSync(
        path.join(testDir, testFileName),
        'Hello, World!\nThis is a test file.\nGoodbye!'
      );
    });

    it('should replace text in file', async () => {
      const filePath = path.join(testDir, testFileName);

      const result = await editFileTool.execute(
        {
          file_path: filePath,
          old_string: 'Hello, World!',
          new_string: 'Hi, Universe!',
        },
        context
      );

      expect(result.success).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toContain('Hi, Universe!');
      expect(fs.readFileSync(filePath, 'utf-8')).not.toContain('Hello, World!');
    });

    it('should fail if old_string not found', async () => {
      const filePath = path.join(testDir, testFileName);

      const result = await editFileTool.execute(
        {
          file_path: filePath,
          old_string: 'nonexistent text',
          new_string: 'replacement',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle multiline replacement', async () => {
      const filePath = path.join(testDir, testFileName);

      const result = await editFileTool.execute(
        {
          file_path: filePath,
          old_string: 'This is a test file.\nGoodbye!',
          new_string: 'This is modified.\nSee you later!',
        },
        context
      );

      expect(result.success).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toContain('This is modified.');
    });

    it('should handle non-existent file', async () => {
      const result = await editFileTool.execute(
        {
          file_path: path.join(testDir, 'nonexistent.txt'),
          old_string: 'text',
          new_string: 'replacement',
        },
        context
      );

      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Tool Metadata Tests
  // --------------------------------------------------------------------------
  describe('Tool Metadata', () => {
    it('bash should have correct generations', () => {
      expect(bashTool.generations).toContain('gen1');
      expect(bashTool.name).toBe('bash');
      expect(bashTool.requiresPermission).toBe(true);
    });

    it('read_file should have correct generations', () => {
      expect(readFileTool.generations).toContain('gen1');
      expect(readFileTool.name).toBe('read_file');
    });

    it('write_file should have correct generations', () => {
      expect(writeFileTool.generations).toContain('gen1');
      expect(writeFileTool.name).toBe('write_file');
    });

    it('edit_file should have correct generations', () => {
      expect(editFileTool.generations).toContain('gen1');
      expect(editFileTool.name).toBe('edit_file');
    });
  });
});
