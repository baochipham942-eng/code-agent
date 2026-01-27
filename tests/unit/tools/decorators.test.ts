// ============================================================================
// Decorator Tools Tests
// TDD tests for the decorator-based tool system
// ============================================================================

import { describe, it, expect } from 'vitest';
import 'reflect-metadata';

// Import decorators and utilities
import { Tool, getToolMetadata } from '../../../src/main/tools/decorators/tool';
import { Param, getParamMetadata } from '../../../src/main/tools/decorators/param';
import { Description, getDescriptionMetadata } from '../../../src/main/tools/decorators/description';
import type { ITool } from '../../../src/main/tools/decorators/types';
import type { ToolContext, ToolExecutionResult } from '../../../src/main/tools/toolRegistry';

// Import decorated tools
import { BashTool } from '../../../src/main/tools/decorated/BashTool';
import { GlobTool } from '../../../src/main/tools/decorated/GlobTool';
import { ReadFileTool } from '../../../src/main/tools/decorated/ReadFileTool';

// ----------------------------------------------------------------------------
// @Tool Decorator Tests
// ----------------------------------------------------------------------------

describe('@Tool Decorator', () => {
  it('should store tool name in metadata', () => {
    const metadata = getToolMetadata(BashTool);
    expect(metadata).toBeDefined();
    expect(metadata!.name).toBe('bash');
  });

  it('should parse "gen1+" generation spec correctly', () => {
    const metadata = getToolMetadata(BashTool);
    expect(metadata!.generations).toContain('gen1');
    expect(metadata!.generations).toContain('gen8');
    expect(metadata!.generations.length).toBe(8);
  });

  it('should parse "gen2+" generation spec correctly', () => {
    const metadata = getToolMetadata(GlobTool);
    expect(metadata!.generations).not.toContain('gen1');
    expect(metadata!.generations).toContain('gen2');
    expect(metadata!.generations).toContain('gen8');
    expect(metadata!.generations.length).toBe(7);
  });

  it('should store permission level', () => {
    const bashMetadata = getToolMetadata(BashTool);
    expect(bashMetadata!.permission).toBe('execute');

    const globMetadata = getToolMetadata(GlobTool);
    expect(globMetadata!.permission).toBe('none');
  });

  it('should default requiresConfirmation to false', () => {
    const metadata = getToolMetadata(BashTool);
    expect(metadata!.requiresConfirmation).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// @Param Decorator Tests
// ----------------------------------------------------------------------------

describe('@Param Decorator', () => {
  it('should store parameter metadata', () => {
    const params = getParamMetadata(BashTool);
    expect(params).toBeDefined();
    expect(params.length).toBeGreaterThan(0);
  });

  it('should have command as first required param for BashTool', () => {
    const params = getParamMetadata(BashTool);
    const commandParam = params.find(p => p.name === 'command');
    expect(commandParam).toBeDefined();
    expect(commandParam!.type).toBe('string');
    expect(commandParam!.required).toBe(true);
  });

  it('should have optional timeout param for BashTool', () => {
    const params = getParamMetadata(BashTool);
    const timeoutParam = params.find(p => p.name === 'timeout');
    expect(timeoutParam).toBeDefined();
    expect(timeoutParam!.type).toBe('number');
    expect(timeoutParam!.required).toBe(false);
  });

  it('should have pattern as required param for GlobTool', () => {
    const params = getParamMetadata(GlobTool);
    const patternParam = params.find(p => p.name === 'pattern');
    expect(patternParam).toBeDefined();
    expect(patternParam!.type).toBe('string');
    expect(patternParam!.required).toBe(true);
  });

  it('should include parameter descriptions', () => {
    const params = getParamMetadata(BashTool);
    const commandParam = params.find(p => p.name === 'command');
    expect(commandParam!.description).toBeDefined();
    expect(commandParam!.description).toContain('command');
  });
});

// ----------------------------------------------------------------------------
// @Description Decorator Tests
// ----------------------------------------------------------------------------

describe('@Description Decorator', () => {
  it('should store description for BashTool', () => {
    const description = getDescriptionMetadata(BashTool);
    expect(description).toBeDefined();
    expect(description).toContain('shell');
  });

  it('should store description for GlobTool', () => {
    const description = getDescriptionMetadata(GlobTool);
    expect(description).toBeDefined();
    expect(description).toContain('pattern');
  });
});

// ----------------------------------------------------------------------------
// BashTool Execute Tests
// ----------------------------------------------------------------------------

describe('BashTool.execute', () => {
  const tool = new BashTool();
  const mockContext: ToolContext = {
    workingDirectory: process.cwd(),
    sessionId: 'test-session',
    generationId: 'gen1',
    conversationId: 'test-conversation',
    orchestrator: {} as never,
  };

  it('should execute simple echo command', async () => {
    const result = await tool.execute(
      { command: 'echo "hello world"' },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello world');
  });

  it('should return error for invalid command', async () => {
    const result = await tool.execute(
      { command: 'nonexistent_command_xyz_123' },
      mockContext
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should respect working directory', async () => {
    const result = await tool.execute(
      { command: 'pwd', working_directory: '/tmp' },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('/tmp');
  });

  it('should capture stderr', async () => {
    const result = await tool.execute(
      { command: 'ls /nonexistent_dir_xyz 2>&1 || true' },
      mockContext
    );
    expect(result.success).toBe(true);
  });

  it('should handle timeout parameter', async () => {
    const startTime = Date.now();
    const result = await tool.execute(
      { command: 'sleep 5', timeout: 100 },
      mockContext
    );
    const elapsed = Date.now() - startTime;

    expect(result.success).toBe(false);
    expect(elapsed).toBeLessThan(2000); // Should timeout quickly
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
    generationId: 'gen2',
    conversationId: 'test-conversation',
    orchestrator: {} as never,
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
  it('should export all decorated tool classes', async () => {
    const { DecoratedToolClasses } = await import('../../../src/main/tools/decorated');
    expect(DecoratedToolClasses).toBeDefined();
    expect(DecoratedToolClasses.length).toBe(3);
    expect(DecoratedToolClasses).toContain(BashTool);
    expect(DecoratedToolClasses).toContain(GlobTool);
    expect(DecoratedToolClasses).toContain(ReadFileTool);
  });

  it('should all implement ITool interface', () => {
    const tools = [new BashTool(), new GlobTool(), new ReadFileTool()];
    for (const tool of tools) {
      expect(typeof tool.execute).toBe('function');
    }
  });
});
