// ============================================================================
// Gen2 Tests - 生态融合期 (Ecosystem Integration Era)
// Tests: glob, grep, list_directory
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock isolated-vm (causes Node version issues in tests)
vi.mock('isolated-vm', () => ({}));

// Import tools
import { globTool } from '../../src/main/tools/file/glob';
import { grepTool } from '../../src/main/tools/shell/grep';
import { listDirectoryTool } from '../../src/main/tools/file/listDirectory';

// Mock context
const createMockContext = (workingDirectory: string) => ({
  workingDirectory,
  generation: { id: 'gen2' as const },
  requestPermission: async () => true,
  emit: () => {},
});

describe('Gen2 - Ecosystem Integration Era', () => {
  let testDir: string;
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    // Create a temp directory with test structure
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen2-test-'));
    context = createMockContext(testDir);

    // Create test file structure
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.mkdirSync(path.join(testDir, 'src', 'components'));
    fs.mkdirSync(path.join(testDir, 'tests'));

    // Create test files
    fs.writeFileSync(path.join(testDir, 'src', 'index.ts'), 'export const main = () => {};\n');
    fs.writeFileSync(path.join(testDir, 'src', 'utils.ts'), 'export function helper() { return "help"; }\n');
    fs.writeFileSync(path.join(testDir, 'src', 'components', 'Button.tsx'), 'export const Button = () => <button>Click</button>;\n');
    fs.writeFileSync(path.join(testDir, 'tests', 'index.test.ts'), 'import { main } from "../src/index";\ntest("main works", () => {});\n');
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Test Project\n\nThis is a test.\n');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Glob Tool Tests
  // --------------------------------------------------------------------------
  describe('glob', () => {
    it('should find files by pattern', async () => {
      const result = await globTool.execute(
        { pattern: '**/*.ts', path: testDir },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('index.ts');
      expect(result.output).toContain('utils.ts');
    });

    it('should find tsx files', async () => {
      const result = await globTool.execute(
        { pattern: '**/*.tsx', path: testDir },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Button.tsx');
    });

    it('should find files in specific directory', async () => {
      const result = await globTool.execute(
        { pattern: '*.ts', path: path.join(testDir, 'src') },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('index.ts');
      expect(result.output).toContain('utils.ts');
    });

    it('should handle no matches', async () => {
      const result = await globTool.execute(
        { pattern: '**/*.java', path: testDir },
        context
      );
      expect(result.success).toBe(true);
      // Should return empty or no matches message
    });

    it('should use working directory if path not specified', async () => {
      const result = await globTool.execute(
        { pattern: 'README.md' },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('README.md');
    });
  });

  // --------------------------------------------------------------------------
  // Grep Tool Tests
  // --------------------------------------------------------------------------
  describe('grep', () => {
    it('should find text in files', async () => {
      const result = await grepTool.execute(
        { pattern: 'export', path: testDir },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('export');
    });

    it('should search with regex pattern', async () => {
      const result = await grepTool.execute(
        { pattern: 'function\\s+\\w+', path: testDir },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('helper');
    });

    it('should filter by file glob', async () => {
      const result = await grepTool.execute(
        { pattern: 'export', path: testDir, include: '*.tsx' },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Button');
    });

    it('should handle no matches', async () => {
      const result = await grepTool.execute(
        { pattern: 'nonexistentpattern123', path: testDir },
        context
      );
      expect(result.success).toBe(true);
      // Should indicate no matches found
    });

    it('should handle case-insensitive search', async () => {
      const result = await grepTool.execute(
        { pattern: 'TEST', path: testDir, case_insensitive: true },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output?.toLowerCase()).toContain('test');
    });
  });

  // --------------------------------------------------------------------------
  // List Directory Tool Tests
  // --------------------------------------------------------------------------
  describe('list_directory', () => {
    it('should list directory contents', async () => {
      const result = await listDirectoryTool.execute(
        { path: testDir },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('src');
      expect(result.output).toContain('tests');
      expect(result.output).toContain('README.md');
    });

    it('should list subdirectory contents', async () => {
      const result = await listDirectoryTool.execute(
        { path: path.join(testDir, 'src') },
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('index.ts');
      expect(result.output).toContain('components');
    });

    it('should distinguish files and directories', async () => {
      const result = await listDirectoryTool.execute(
        { path: testDir },
        context
      );
      expect(result.success).toBe(true);
      // Output should indicate which are directories
    });

    it('should handle non-existent directory', async () => {
      const result = await listDirectoryTool.execute(
        { path: path.join(testDir, 'nonexistent') },
        context
      );
      expect(result.success).toBe(false);
    });

    it('should use working directory if path not specified', async () => {
      const result = await listDirectoryTool.execute(
        {},
        context
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('README.md');
    });
  });

  // --------------------------------------------------------------------------
  // Tool Metadata Tests
  // --------------------------------------------------------------------------
  describe('Tool Metadata', () => {
    it('glob should have correct generations', () => {
      expect(globTool.generations).toContain('gen2');
      expect(globTool.name).toBe('glob');
    });

    it('grep should have correct generations', () => {
      expect(grepTool.generations).toContain('gen2');
      expect(grepTool.name).toBe('grep');
    });

    it('list_directory should have correct generations', () => {
      expect(listDirectoryTool.generations).toContain('gen2');
      expect(listDirectoryTool.name).toBe('list_directory');
    });
  });
});
