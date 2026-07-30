import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FolderTrustDialog } from '../../../src/renderer/components/FolderTrustDialog';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const noop = () => {};

describe('FolderTrustDialog', () => {
  it('renders blocked project configuration with path and risk labels', () => {
    const html = renderToStaticMarkup(
      <FolderTrustDialog
        evaluation={{
          state: 'blocked',
          canonicalRealpath: '/real/project',
          displayPath: '/tmp/link-project',
          identityChanged: true,
          dangerousItems: [
            {
              kind: 'project-hooks',
              displayPath: '.code-agent/hooks/hooks.json',
              label: 'Project hooks',
              risk: 'execution',
              gated: true,
            },
            {
              kind: 'project-mcp-local',
              displayPath: '.code-agent/mcp.local.json',
              label: 'Local project MCP servers',
              risk: 'mcp',
              gated: true,
            },
          ],
          blockedItems: [],
        }}
        onTrust={noop}
        onBlock={noop}
        onOpenSettings={noop}
      />,
    );

    expect(html).toContain(zh.folderTrust.title);
    expect(html).toContain('/real/project');
    expect(html).toContain('.code-agent/hooks/hooks.json');
    expect(html).toContain(zh.folderTrust.identityChanged);
    expect(html).toContain(zh.folderTrust.risks.execution);
    expect(html).toContain(zh.folderTrust.risks.mcp);
  });

  it('requireDangerousItems=false 时零危险项的未信任评估也渲染（说明文案，无清单）', () => {
    const html = renderToStaticMarkup(
      <FolderTrustDialog
        evaluation={{
          state: 'untrusted',
          canonicalRealpath: '/ws',
          displayPath: '/ws',
          identityChanged: true,
          dangerousItems: [],
          blockedItems: [],
        }}
        requireDangerousItems={false}
        onTrust={noop}
        onBlock={noop}
        onOpenSettings={noop}
      />,
    );

    expect(html).toContain(zh.folderTrust.title);
    expect(html).toContain(zh.folderTrust.emptyDangerNote);
    expect(html).toContain(zh.folderTrust.identityChanged);
    expect(html).not.toContain('folder-trust-danger-list');
  });

  it('默认 requireDangerousItems=true：零危险项不渲染；trusted 一律不渲染', () => {
    const base = {
      state: 'untrusted' as const,
      canonicalRealpath: '/ws',
      displayPath: '/ws',
      identityChanged: false,
      dangerousItems: [],
      blockedItems: [],
    };
    expect(
      renderToStaticMarkup(
        <FolderTrustDialog evaluation={base} onTrust={noop} onBlock={noop} onOpenSettings={noop} />,
      ),
    ).toBe('');
    expect(
      renderToStaticMarkup(
        <FolderTrustDialog
          evaluation={{ ...base, state: 'trusted' }}
          requireDangerousItems={false}
          onTrust={noop}
          onBlock={noop}
          onOpenSettings={noop}
        />,
      ),
    ).toBe('');
  });

  it('keeps zh/en folder trust keys aligned', () => {
    expect(Object.keys(en.folderTrust).sort()).toEqual(Object.keys(zh.folderTrust).sort());
    expect(Object.keys(en.folderTrust.risks).sort()).toEqual(Object.keys(zh.folderTrust.risks).sort());
  });
});
