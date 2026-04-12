// ============================================================================
// Decorator Tools Tests
// TDD tests for the decorator-based tool system
// ============================================================================

import { describe, it, expect } from 'vitest';
import 'reflect-metadata';

// Import decorators and utilities
import { getToolMetadata } from '../../../src/main/tools/decorators/tool';
import { getParamMetadata } from '../../../src/main/tools/decorators/param';
import { getDescriptionMetadata } from '../../../src/main/tools/decorators/description';
import type { ToolContext } from '../../../src/main/tools/types';

// Import decorated tools
// Note: BashTool was the decorator example and has been retired in P0-6.3
// Batch 2a along with the native Bash rewrite. Glob/ReadFile remain as examples.
import { GlobTool } from '../../../src/main/tools/decorated/GlobTool';
import { ReadFileTool } from '../../../src/main/tools/decorated/ReadFileTool';

// ----------------------------------------------------------------------------
// @Tool Decorator Tests
// ----------------------------------------------------------------------------

describe('@Tool Decorator', () => {
  it('should store tool metadata for GlobTool', () => {
    const metadata = getToolMetadata(GlobTool);
    expect(metadata).toBeDefined();
    expect(metadata!.name).toBe('glob');
    expect(metadata!.permission).toBe('none');
  });

  it('should store permission level for GlobTool', () => {
    const globMetadata = getToolMetadata(GlobTool);
    expect(globMetadata!.permission).toBe('none');
  });

  it('should default requiresConfirmation to false', () => {
    const metadata = getToolMetadata(GlobTool);
    expect(metadata!.requiresConfirmation).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// @Param Decorator Tests
// ----------------------------------------------------------------------------

describe('@Param Decorator', () => {
  it('should store parameter metadata for GlobTool', () => {
    const params = getParamMetadata(GlobTool);
    expect(params).toBeDefined();
    expect(params.length).toBeGreaterThan(0);
  });

  it('should have pattern as required param for GlobTool', () => {
    const params = getParamMetadata(GlobTool);
    const patternParam = params.find(p => p.name === 'pattern');
    expect(patternParam).toBeDefined();
    expect(patternParam!.type).toBe('string');
    expect(patternParam!.required).toBe(true);
  });

  it('should include parameter descriptions', () => {
    const params = getParamMetadata(GlobTool);
    const patternParam = params.find(p => p.name === 'pattern');
    expect(patternParam!.description).toBeDefined();
  });
});

// ----------------------------------------------------------------------------
// @Description Decorator Tests
// ----------------------------------------------------------------------------

describe('@Description Decorator', () => {
  it('should store description for GlobTool', () => {
    const description = getDescriptionMetadata(GlobTool);
    expect(description).toBeDefined();
    expect(description).toContain('pattern');
  });
});

// ----------------------------------------------------------------------------
// GlobTool Execute Tests
// ----------------------------------------------------------------------------

describe('GlobTool.execute', () => {
  const tool = new GlobTool();
  const mockContext: ToolContext = {
    workingDirectory: process.cwd(),
    sessionId: 'test-session',
    requestPermission: async () => true,
  };

  it('should find TypeScript files', async () => {
    const result = await tool.execute(
      { pattern: '*.ts', path: 'src/main/tools/decorators' },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('.ts');
  });

  it('should return message for no matches', async () => {
    const result = await tool.execute(
      { pattern: '*.nonexistent_extension_xyz' },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('No files matched');
  });

  it('should ignore node_modules by default', async () => {
    const result = await tool.execute(
      { pattern: '**/*.js' },
      mockContext
    );
    expect(result.success).toBe(true);
    // Should not contain node_modules paths
    if (result.output && !result.output.includes('No files matched')) {
      expect(result.output).not.toContain('node_modules');
    }
  });
});

// ----------------------------------------------------------------------------
// Integration: Decorated Tools Export
// ----------------------------------------------------------------------------

describe('DecoratedToolClasses', () => {
  it('should export remaining decorated tool classes (BashTool retired)', async () => {
    const { DecoratedToolClasses } = await import('../../../src/main/tools/decorated');
    expect(DecoratedToolClasses).toBeDefined();
    expect(DecoratedToolClasses.length).toBe(2);
    expect(DecoratedToolClasses).toContain(GlobTool);
    expect(DecoratedToolClasses).toContain(ReadFileTool);
  });

  it('should all implement ITool interface', () => {
    const tools = [new GlobTool(), new ReadFileTool()];
    for (const tool of tools) {
      expect(typeof tool.execute).toBe('function');
    }
  });
});
