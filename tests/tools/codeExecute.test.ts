// ============================================================================
// Code Execute (PTC) Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../src/main/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock security (used by both codeExecute and ToolExecutor)
vi.mock('../../src/main/security', () => ({
  getAuditLogger: vi.fn(() => ({
    logToolUsage: vi.fn(),
    logSecurityIncident: vi.fn(),
    log: vi.fn(),
  })),
  getCommandMonitor: vi.fn(() => ({
    preExecute: vi.fn().mockReturnValue({ allowed: true, securityFlags: [], riskLevel: 'low' }),
  })),
  maskSensitiveData: vi.fn((s: string) => s),
}));

// Mock services (ToolCache, used by ToolExecutor)
vi.mock('../../src/main/services', () => ({
  getToolCache: vi.fn(() => ({
    isCacheable: vi.fn().mockReturnValue(false),
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  })),
}));

// Mock ConfirmationGate (used by ToolExecutor)
vi.mock('../../src/main/agent/confirmationGate', () => ({
  getConfirmationGate: vi.fn(() => ({
    buildPreview: vi.fn().mockReturnValue(null),
  })),
}));

// Mock file checkpoint middleware (used by ToolExecutor)
vi.mock('../../src/main/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

// Mock cloud config service (used by ToolRegistry)
vi.mock('../../src/main/services/cloud', () => ({
  getCloudConfigService: vi.fn(() => ({
    getAllToolMeta: vi.fn().mockReturnValue({}),
    getToolMeta: vi.fn().mockReturnValue(null),
  })),
}));

import { validateCodeSafety } from '../../src/main/tools/evolution/codeValidator';
import { codeExecuteTool } from '../../src/main/tools/evolution/codeExecute';
import type { ToolContext, Tool } from '../../src/main/tools/toolRegistry';

// ============================================================================
// Code Validator Tests
// ============================================================================

describe('validateCodeSafety', () => {
  it('should accept valid code', () => {
    const result = validateCodeSafety('const x = 1 + 2; return x;');
    expect(result.valid).toBe(true);
  });

  it('should accept code with callTool', () => {
    const result = validateCodeSafety(`
      const r = await callTool('read_file', { file_path: 'test.ts' });
      return r.output;
    `);
    expect(result.valid).toBe(true);
  });

  it('should reject require()', () => {
    const result = validateCodeSafety("const fs = require('fs');");
    expect(result.valid).toBe(false);
    expect(result.error).toContain('require()');
  });

  it('should reject dynamic import()', () => {
    const result = validateCodeSafety("const m = await import('fs');");
    expect(result.valid).toBe(false);
    expect(result.error).toContain('import()');
  });

  it('should reject import statement', () => {
    const result = validateCodeSafety("import fs from 'fs';");
    expect(result.valid).toBe(false);
    expect(result.error).toContain('import statement');
  });

  it('should reject process.exit', () => {
    const result = validateCodeSafety('process.exit(1);');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('process.exit');
  });

  it('should reject process.env', () => {
    const result = validateCodeSafety('const key = process.env.API_KEY;');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('process.env');
  });

  it('should reject eval()', () => {
    const result = validateCodeSafety('eval("alert(1)");');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('eval()');
  });

  it('should reject Function() constructor', () => {
    const result = validateCodeSafety('const fn = new Function("return 1");');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Function() constructor');
  });

  it('should reject __proto__', () => {
    const result = validateCodeSafety('obj.__proto__.polluted = true;');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('__proto__');
  });

  it('should reject child_process', () => {
    const result = validateCodeSafety("const { exec } = child_process;");
    expect(result.valid).toBe(false);
    expect(result.error).toContain('child_process');
  });

  it('should reject empty code', () => {
    const result = validateCodeSafety('');
    expect(result.valid).toBe(false);
  });

  it('should reject code exceeding 50KB', () => {
    const code = 'x'.repeat(51_000);
    const result = validateCodeSafety(code);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too long');
  });
});

// ============================================================================
// Code Execute Tool Definition Tests
// ============================================================================

describe('codeExecuteTool definition', () => {
  it('should have correct name', () => {
    expect(codeExecuteTool.name).toBe('code_execute');
  });

  it('should be defined with correct name', () => {
    expect(codeExecuteTool.name).toBeDefined();
  });

  it('should require permission', () => {
    expect(codeExecuteTool.requiresPermission).toBe(true);
    expect(codeExecuteTool.permissionLevel).toBe('execute');
  });

  it('should require code parameter', () => {
    expect(codeExecuteTool.inputSchema.required).toContain('code');
  });
});

// ============================================================================
// Code Execute Tool Execution Tests
// ============================================================================

describe('codeExecuteTool.execute', () => {
  let mockContext: ToolContext;
  let mockGlobTool: Tool;
  let mockReadFileTool: Tool;

  beforeEach(() => {
    mockGlobTool = {
      name: 'glob',
      description: 'Find files',
      inputSchema: { type: 'object', properties: {}, required: [] },
      generations: ['gen8'],
      requiresPermission: false,
      permissionLevel: 'read',
      execute: vi.fn().mockResolvedValue({ success: true, output: 'file1.ts\nfile2.ts' }),
    };

    mockReadFileTool = {
      name: 'read_file',
      description: 'Read files',
      inputSchema: { type: 'object', properties: {}, required: [] },
      generations: ['gen8'],
      requiresPermission: false,
      permissionLevel: 'read',
      execute: vi.fn().mockResolvedValue({ success: true, output: 'line1\nline2\nline3' }),
    };

    mockContext = {
      workingDirectory: '/tmp/test',
      generation: { id: 'gen8' },
      requestPermission: vi.fn().mockResolvedValue(true),
      sessionId: 'test-session',
      toolRegistry: {
        get: vi.fn((name: string) => {
          if (name === 'glob') return mockGlobTool;
          if (name === 'read_file') return mockReadFileTool;
          return undefined;
        }),
      } as any,
    };
  });

  it('should reject code that fails validation', async () => {
    const result = await codeExecuteTool.execute(
      { code: "const fs = require('fs');" },
      mockContext
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('require()');
  });

  it('should reject NEVER_ALLOWED tools', async () => {
    const result = await codeExecuteTool.execute(
      {
        code: 'return 1;',
        allowed_tools: ['code_execute'],
      },
      mockContext
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('never allowed');
  });

  it('should reject invalid tool names', async () => {
    const result = await codeExecuteTool.execute(
      {
        code: 'return 1;',
        allowed_tools: ['nonexistent_fantasy_tool'],
      },
      mockContext
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a valid tool');
  });

  it('should execute simple code and return result', async () => {
    const result = await codeExecuteTool.execute(
      { code: 'return 2 + 3;' },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('5');
  }, 15_000);

  it('should capture console.log output', async () => {
    const result = await codeExecuteTool.execute(
      { code: 'console.log("hello"); console.log("world"); return "done";' },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
    expect(result.output).toContain('world');
    expect(result.output).toContain('done');
  }, 15_000);

  it('should handle callTool and bridge to real tools', async () => {
    const result = await codeExecuteTool.execute(
      {
        code: `
          const r = await callTool('glob', { pattern: '*.ts' });
          return r.output;
        `,
      },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('file1.ts');
    expect(mockGlobTool.execute).toHaveBeenCalled();
  }, 15_000);

  it('should handle errors in code gracefully', async () => {
    const result = await codeExecuteTool.execute(
      { code: 'throw new Error("test error");' },
      mockContext
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('test error');
  }, 15_000);

  it('should handle tool call to disallowed tool', async () => {
    const result = await codeExecuteTool.execute(
      {
        code: `
          try {
            await callTool('spawn_agent', {});
          } catch (e) {
            return 'blocked: ' + e.message;
          }
        `,
      },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('not in allowed list');
  }, 15_000);

  it('should timeout long-running code', async () => {
    const result = await codeExecuteTool.execute(
      {
        code: 'await new Promise(r => setTimeout(r, 30000)); return "done";',
        timeout: 2000,
      },
      mockContext
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 10_000);

  it('should enforce tool call count limit (50 max)', async () => {
    // Generate code that calls a tool 51 times
    const result = await codeExecuteTool.execute(
      {
        code: `
          let count = 0;
          try {
            for (let i = 0; i < 51; i++) {
              await callTool('glob', { pattern: '*.ts' });
              count++;
            }
            return 'completed ' + count;
          } catch (e) {
            return 'stopped at ' + count + ': ' + e.message;
          }
        `,
      },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('stopped at 50');
    expect(result.output).toContain('Max tool calls exceeded');
  }, 30_000);

  it('should truncate output exceeding 32KB', async () => {
    // Generate code that produces >32KB output via console.log
    const result = await codeExecuteTool.execute(
      {
        code: `
          const big = 'x'.repeat(40000);
          console.log(big);
          return 'end';
        `,
      },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('[Output truncated at 32KB]');
    // Should be capped around 32KB + truncation message
    expect(result.output!.length).toBeLessThan(35000);
  }, 15_000);

  it('should handle multiple sequential tool calls', async () => {
    const result = await codeExecuteTool.execute(
      {
        code: `
          const files = await callTool('glob', { pattern: '*.ts' });
          const lines = files.output.split('\\n').filter(Boolean);
          let total = 0;
          for (const f of lines) {
            const r = await callTool('read_file', { file_path: f });
            if (r.success) total += r.output.split('\\n').length;
          }
          return total + ' lines in ' + lines.length + ' files';
        `,
      },
      mockContext
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('6 lines in 2 files');
    // glob called once, read_file called twice
    expect(mockGlobTool.execute).toHaveBeenCalledTimes(1);
    expect(mockReadFileTool.execute).toHaveBeenCalledTimes(2);
  }, 15_000);
});
