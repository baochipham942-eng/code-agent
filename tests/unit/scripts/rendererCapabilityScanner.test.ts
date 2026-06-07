import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectRendererShellCapabilities,
  parseIpcDomains,
} from '../../../scripts/renderer-capability-scanner.mjs';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-capability-scanner-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('renderer capability scanner', () => {
  it('parses IPC_DOMAINS constants', () => {
    expect(parseIpcDomains("export const IPC_DOMAINS = { UPDATE: 'domain:update' } as const;"))
      .toEqual({ UPDATE: 'domain:update' });
  });

  it('collects static renderer domain invocations', () => {
    const rendererDir = path.join(tmp, 'renderer');
    fs.mkdirSync(rendererDir, { recursive: true });
    const domainsPath = path.join(tmp, 'domains.ts');
    fs.writeFileSync(
      domainsPath,
      "export const IPC_DOMAINS = { UPDATE: 'domain:update', MCP: 'domain:mcp', AUTH: 'domain:auth', WORKSPACE: 'domain:workspace' } as const;\n",
    );
    fs.writeFileSync(path.join(rendererDir, 'App.tsx'), `
      import { IPC_DOMAINS } from '../shared/ipc/domains';
      await ipcService.invokeDomain(IPC_DOMAINS.UPDATE, 'check');
      await invokeDomain<{ ok: boolean }>(IPC_DOMAINS.MCP, 'listTools');
      await window.domainAPI?.invoke(IPC_DOMAINS.UPDATE, 'check');
      await window.domainAPI.invoke('domain:mcp', 'getStatus');
      await window.domainAPI.invoke('auth', 'saveCredentials');
      await window.domainAPI?.invoke('workspace', 'openPath');
      await window.domainAPI.invoke('unknownLegacyDomain', 'ignored');
      await invoke<string>('desktop_get_capabilities');
      await internals.invoke('appshots_report_composer_slot', { slot: {} });
      await tauriInvoke('pip_show');
    `);

    expect(collectRendererShellCapabilities({ rendererDir, domainsPath, repoRoot: tmp }))
      .toEqual([
        {
          id: 'domain:auth/saveCredentials',
          domain: 'domain:auth',
          action: 'saveCredentials',
          layer: 'domain',
          file: 'renderer/App.tsx',
        },
        {
          id: 'domain:mcp/getStatus',
          domain: 'domain:mcp',
          action: 'getStatus',
          layer: 'domain',
          file: 'renderer/App.tsx',
        },
        {
          id: 'domain:mcp/listTools',
          domain: 'domain:mcp',
          action: 'listTools',
          layer: 'domain',
          file: 'renderer/App.tsx',
        },
        {
          id: 'domain:update/check',
          domain: 'domain:update',
          action: 'check',
          layer: 'domain',
          file: 'renderer/App.tsx',
        },
        {
          id: 'domain:workspace/openPath',
          domain: 'domain:workspace',
          action: 'openPath',
          layer: 'domain',
          file: 'renderer/App.tsx',
        },
        {
          id: 'native:tauri/appshots_report_composer_slot',
          domain: 'native:tauri',
          action: 'appshots_report_composer_slot',
          layer: 'native',
          file: 'renderer/App.tsx',
        },
        {
          id: 'native:tauri/desktop_get_capabilities',
          domain: 'native:tauri',
          action: 'desktop_get_capabilities',
          layer: 'native',
          file: 'renderer/App.tsx',
        },
        {
          id: 'native:tauri/pip_show',
          domain: 'native:tauri',
          action: 'pip_show',
          layer: 'native',
          file: 'renderer/App.tsx',
        },
      ]);
  });
});
