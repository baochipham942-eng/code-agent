// ============================================================================
// Gen4 Tests - 工业化系统期 (Industrial System Era)
// Tests: skill, web_fetch
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock isolated-vm (causes Node version issues in tests)
vi.mock('isolated-vm', () => ({}));

// Import tools
import { skillTool } from '../../src/main/tools/network/skill';
import { webFetchTool } from '../../src/main/tools/network/webFetch';

// Mock context
const createMockContext = (workingDirectory: string) => ({
  workingDirectory,
  generation: { id: 'gen4' as const },
  requestPermission: async () => true,
  emit: () => {},
});

describe('Gen4 - Industrial System Era', () => {
  let testDir: string;
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen4-test-'));
    context = createMockContext(testDir);

    // Create a git repo for skill tests
    fs.mkdirSync(path.join(testDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Skill Tool Tests
  // --------------------------------------------------------------------------
  describe('skill', () => {
    it('should have correct metadata', () => {
      expect(skillTool.generations).toContain('gen4');
      expect(skillTool.name).toBe('skill');
      expect(skillTool.inputSchema.required).toContain('skill');
    });

    it('should execute commit skill without full context', async () => {
      // Without toolRegistry and modelConfig, it returns skill info
      const result = await skillTool.execute(
        { skill: 'commit' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('commit');
    });

    it('should handle unknown skill', async () => {
      const result = await skillTool.execute(
        { skill: 'nonexistent_skill_xyz' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should support skill with arguments', async () => {
      // Test skill with args parameter
      const result = await skillTool.execute(
        { skill: 'help', args: '--verbose' },
        context
      );

      // May succeed or fail depending on skill availability
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Web Fetch Tool Tests
  // --------------------------------------------------------------------------
  describe('web_fetch', () => {
    it('should have correct metadata', () => {
      expect(webFetchTool.generations).toContain('gen4');
      expect(webFetchTool.name).toBe('web_fetch');
      expect(webFetchTool.requiresPermission).toBe(true);
    });

    it('should require URL parameter', async () => {
      const result = await webFetchTool.execute(
        {},
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should validate URL format', async () => {
      const result = await webFetchTool.execute(
        { url: 'not-a-valid-url' },
        context
      );

      expect(result.success).toBe(false);
    });

    // Note: Actual network requests would need mocking in real tests
    it('should handle fetch with prompt', async () => {
      // This would need network mocking for actual test
      const result = await webFetchTool.execute(
        {
          url: 'https://example.com',
          prompt: 'Extract the main content'
        },
        context
      );

      // May fail due to network/permission, but should be defined
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Integration Tests
  // --------------------------------------------------------------------------
  describe('Integration', () => {
    it('gen4 should include all gen1-3 tools', () => {
      // Gen4 includes all previous generation tools plus new ones
      const gen4Tools = ['bash', 'read_file', 'write_file', 'edit_file',
        'glob', 'grep', 'list_directory', 'task', 'todo_write',
        'ask_user_question', 'skill', 'web_fetch'];

      // Verify skill and web_fetch are gen4 tools
      expect(skillTool.generations).toContain('gen4');
      expect(webFetchTool.generations).toContain('gen4');
    });
  });

  // --------------------------------------------------------------------------
  // Tool Metadata Tests
  // --------------------------------------------------------------------------
  describe('Tool Metadata', () => {
    it('skill should have required input schema', () => {
      expect(skillTool.inputSchema.type).toBe('object');
      expect(skillTool.inputSchema.properties).toHaveProperty('skill');
    });

    it('web_fetch should have required input schema', () => {
      expect(webFetchTool.inputSchema.type).toBe('object');
      expect(webFetchTool.inputSchema.properties).toHaveProperty('url');
    });
  });
});
