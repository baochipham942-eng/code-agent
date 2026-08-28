import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const requestHandlers = vi.hoisted(() => new Map<string, () => Promise<unknown>>());

vi.mock('@modelcontextprotocol/server', () => ({
  Server: class MockServer {
    setRequestHandler(method: string, handler: () => Promise<unknown>): void {
      requestHandlers.set(method, handler);
    }
  },
}));

import { CodeAgentMCPServer } from '../../../src/host/mcp/mcpServer';

const hostDir = fileURLToPath(new URL('../../../src/host/', import.meta.url));
const productionRoots = ['agent', 'model', 'context', 'mcp'];

function collectTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(filePath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [filePath] : [];
  });
}

describe('production MCP and testing dependency boundaries', () => {
  it('does not expose the removed evaluation query through tools/list', async () => {
    new CodeAgentMCPServer();
    const listTools = requestHandlers.get('tools/list');
    const removedToolName = ['eval', 'query'].join('-');

    expect(listTools).toBeDefined();
    const response = await listTools!() as { tools: Array<{ name: string }> };
    expect(response.tools.map((tool) => tool.name)).not.toContain(removedToolName);
  });

  it('keeps production host directories free of static testing imports', () => {
    const violations = productionRoots.flatMap((rootName) =>
      collectTypeScriptFiles(path.join(hostDir, rootName)).flatMap((filePath) => {
        const source = fs.readFileSync(filePath, 'utf8');
        const hasStaticTestingImport = /(?:\bfrom\s*|\bimport\s*)['"](?:\.\.\/)+testing\//.test(source);
        return hasStaticTestingImport ? [path.relative(hostDir, filePath)] : [];
      }),
    );

    expect(violations).toEqual([]);
  });

  it('keeps MCP production sources free of all testing imports', () => {
    const violations = collectTypeScriptFiles(path.join(hostDir, 'mcp')).flatMap((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      const hasTestingImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"][^'"]*testing\//.test(source);
      return hasTestingImport ? [path.relative(hostDir, filePath)] : [];
    });

    expect(violations).toEqual([]);
  });
});
