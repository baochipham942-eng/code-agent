// ============================================================================
// Gen5 Tests - 认知增强期 (Cognitive Enhancement Era)
// Tests: memory_store, memory_search, code_index, auto_learn
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import tools
import { memoryStoreTool } from '../../src/main/tools/gen5/memoryStore';
import { memorySearchTool } from '../../src/main/tools/gen5/memorySearch';
import { codeIndexTool } from '../../src/main/tools/gen5/codeIndex';
import { autoLearnTool } from '../../src/main/tools/gen5/autoLearn';

// Mock the memory service
vi.mock('../../src/main/memory/MemoryService', () => ({
  getMemoryService: () => ({
    saveProjectKnowledge: vi.fn(),
    searchKnowledge: vi.fn().mockReturnValue([]),
    getProjectKnowledge: vi.fn().mockReturnValue(null),
    addKnowledge: vi.fn().mockResolvedValue(undefined),
    getUserPreference: vi.fn().mockReturnValue({}),
    setUserPreference: vi.fn(),
    searchRelevantConversations: vi.fn().mockReturnValue([]),
    searchRelevantCode: vi.fn().mockReturnValue([]),
    indexCodeFile: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../src/main/memory/VectorStore', () => ({
  getVectorStore: () => ({
    addKnowledge: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    indexCode: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock context
const createMockContext = (workingDirectory: string) => ({
  workingDirectory,
  generation: { id: 'gen5' as const },
  requestPermission: async () => true,
  emit: () => {},
});

describe('Gen5 - Cognitive Enhancement Era', () => {
  let testDir: string;
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen5-test-'));
    context = createMockContext(testDir);

    // Create some test files for indexing
    fs.writeFileSync(
      path.join(testDir, 'example.ts'),
      'export function calculateSum(a: number, b: number): number {\n  return a + b;\n}\n'
    );
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Memory Store Tool Tests
  // --------------------------------------------------------------------------
  describe('memory_store', () => {
    it('should have correct metadata', () => {
      expect(memoryStoreTool.generations).toContain('gen5');
      expect(memoryStoreTool.name).toBe('memory_store');
    });

    it('should store memory with required fields', async () => {
      const result = await memoryStoreTool.execute(
        {
          content: 'User prefers TypeScript over JavaScript',
          category: 'preference',
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('Memory stored');
    });

    it('should store memory with key', async () => {
      const result = await memoryStoreTool.execute(
        {
          content: 'Always use 2-space indentation',
          category: 'preference',
          key: 'coding_style_indentation',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should reject empty content', async () => {
      const result = await memoryStoreTool.execute(
        {
          content: '',
          category: 'preference',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject sensitive information', async () => {
      const result = await memoryStoreTool.execute(
        {
          content: 'My API_KEY is sk-123456',
          category: 'context',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should support all categories', async () => {
      const categories = ['preference', 'pattern', 'decision', 'context', 'insight', 'error_solution'];

      for (const category of categories) {
        const result = await memoryStoreTool.execute(
          {
            content: `Test content for ${category}`,
            category,
          },
          context
        );
        expect(result.success).toBe(true);
      }
    });

    it('should support confidence parameter', async () => {
      const result = await memoryStoreTool.execute(
        {
          content: 'High confidence memory',
          category: 'pattern',
          confidence: 0.9,
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('0.9');
    });
  });

  // --------------------------------------------------------------------------
  // Memory Search Tool Tests
  // --------------------------------------------------------------------------
  describe('memory_search', () => {
    it('should have correct metadata', () => {
      expect(memorySearchTool.generations).toContain('gen5');
      expect(memorySearchTool.name).toBe('memory_search');
    });

    it('should search with query', async () => {
      const result = await memorySearchTool.execute(
        { query: 'coding style preferences' },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should filter by category', async () => {
      const result = await memorySearchTool.execute(
        {
          query: 'TypeScript',
          category: 'preference',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const result = await memorySearchTool.execute(
        {
          query: 'patterns',
          limit: 5,
        },
        context
      );

      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Code Index Tool Tests
  // --------------------------------------------------------------------------
  describe('code_index', () => {
    it('should have correct metadata', () => {
      expect(codeIndexTool.generations).toContain('gen5');
      expect(codeIndexTool.name).toBe('code_index');
    });

    it('should index code in directory', async () => {
      const result = await codeIndexTool.execute(
        {
          action: 'index',
          path: testDir,
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should search indexed code', async () => {
      const result = await codeIndexTool.execute(
        {
          action: 'search',
          query: 'calculateSum function',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should get index status', async () => {
      const result = await codeIndexTool.execute(
        { action: 'status' },
        context
      );

      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Auto Learn Tool Tests
  // --------------------------------------------------------------------------
  describe('auto_learn', () => {
    it('should have correct metadata', () => {
      expect(autoLearnTool.generations).toContain('gen5');
      expect(autoLearnTool.name).toBe('auto_learn');
    });

    it('should learn code style', async () => {
      const result = await autoLearnTool.execute(
        {
          type: 'code_style',
          content: 'User prefers 2 spaces indentation and single quotes',
          confidence: 0.8,
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should learn from error solution', async () => {
      const result = await autoLearnTool.execute(
        {
          type: 'error_solution',
          content: 'TypeScript error TS2345 fixed by adding type assertion',
          context: 'Type mismatch errors',
          confidence: 0.9,
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should support different learning types', async () => {
      const types = ['code_style', 'pattern', 'preference', 'error_solution', 'project_rule'];

      for (const type of types) {
        const result = await autoLearnTool.execute(
          {
            type,
            content: `Learning content for ${type}`,
            confidence: 0.7,
          },
          context
        );
        expect(result.success).toBe(true);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Tool Metadata Tests
  // --------------------------------------------------------------------------
  describe('Tool Metadata', () => {
    it('all gen5 tools should include gen5-8 generations', () => {
      const gen5Tools = [memoryStoreTool, memorySearchTool, codeIndexTool, autoLearnTool];

      for (const tool of gen5Tools) {
        expect(tool.generations).toContain('gen5');
        expect(tool.generations).toContain('gen6');
        expect(tool.generations).toContain('gen7');
        expect(tool.generations).toContain('gen8');
      }
    });

    it('all gen5 tools should have input schema', () => {
      const gen5Tools = [memoryStoreTool, memorySearchTool, codeIndexTool, autoLearnTool];

      for (const tool of gen5Tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });
});
