import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRendererCapabilityDiff,
  formatRendererCapabilityDiffMarkdown,
  scanRendererCapabilities,
} from '../../../scripts/renderer-capability-diff.mjs';

let tmp: string;

function writeFixture(root: string, source: string) {
  const rendererDir = path.join(root, 'src/renderer');
  const sharedDir = path.join(root, 'src/shared/ipc');
  fs.mkdirSync(rendererDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(
    path.join(sharedDir, 'domains.ts'),
    "export const IPC_DOMAINS = { UPDATE: 'domain:update', MCP: 'domain:mcp', WORKSPACE: 'domain:workspace' } as const;\n",
  );
  fs.writeFileSync(path.join(rendererDir, 'App.tsx'), source);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-capability-diff-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('renderer capability diff', () => {
  it('reports added, removed, and unsupported renderer shell capabilities', () => {
    const baseRoot = path.join(tmp, 'base');
    const headRoot = path.join(tmp, 'head');
    writeFixture(baseRoot, `
      await ipcService.invokeDomain(IPC_DOMAINS.UPDATE, 'check');
      await window.domainAPI.invoke('domain:mcp', 'listTools');
    `);
    writeFixture(headRoot, `
      await window.domainAPI.invoke('domain:mcp', 'listTools');
      await window.domainAPI.invoke('workspace', 'openPath');
      await invoke('desktop_get_capabilities');
    `);

    const baseCapabilities = scanRendererCapabilities({
      rendererDir: path.join(baseRoot, 'src/renderer'),
      domainsPath: path.join(baseRoot, 'src/shared/ipc/domains.ts'),
      repoRoot: baseRoot,
    });
    const headCapabilities = scanRendererCapabilities({
      rendererDir: path.join(headRoot, 'src/renderer'),
      domainsPath: path.join(headRoot, 'src/shared/ipc/domains.ts'),
      repoRoot: headRoot,
    });
    const diff = buildRendererCapabilityDiff({
      baseCapabilities,
      headCapabilities,
      supportedShellCapabilities: [
        'domain:mcp/listTools',
        'domain:workspace/openPath',
      ],
    });

    expect(diff.added.map((capability) => capability.id)).toEqual([
      'domain:workspace/openPath',
      'native:tauri/desktop_get_capabilities',
    ]);
    expect(diff.removed.map((capability) => capability.id)).toEqual([
      'domain:update/check',
    ]);
    expect(diff.unsupported.map((capability) => capability.id)).toEqual([
      'native:tauri/desktop_get_capabilities',
    ]);
    expect(diff.layers).toEqual({
      base: { domain: 2 },
      head: { domain: 2, native: 1 },
    });
    expect(formatRendererCapabilityDiffMarkdown(diff)).toContain('Unsupported By Current Shell');
    expect(formatRendererCapabilityDiffMarkdown(diff)).toContain('Layer');
    expect(formatRendererCapabilityDiffMarkdown(diff)).toContain('head domain=2, native=1');
  });
});
