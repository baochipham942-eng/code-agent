import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FolderTrustDialog, needsFolderTrustDecision } from '../../../src/renderer/components/FolderTrustDialog';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const noop = () => {};

describe('FolderTrustDialog', () => {
  it('renders undecided project configuration with path and risk labels', () => {
    const html = renderToStaticMarkup(
      <FolderTrustDialog
        evaluation={{
          state: 'untrusted',
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

  // 2026-07-27 回归：blocked 是「已决定」不是「还没问」——此前三处调用点都写
  // state !== 'trusted'，导致点「阻止项目配置」后弹窗永不消失、且每次启动重问。
  it('treats blocked and trusted alike as a decision already made', () => {
    const base = {
      canonicalRealpath: '/real/project',
      displayPath: '/tmp/link-project',
      identityChanged: false,
      dangerousItems: [
        {
          kind: 'project-hooks',
          displayPath: '.code-agent/hooks/hooks.json',
          label: 'Project hooks',
          risk: 'execution',
          gated: true,
        },
      ],
      blockedItems: [],
    };

    for (const state of ['blocked', 'trusted'] as const) {
      const evaluation = { ...base, state, dangerousItems: [...base.dangerousItems] };
      expect(needsFolderTrustDecision(evaluation)).toBe(false);
      expect(
        renderToStaticMarkup(
          <FolderTrustDialog evaluation={evaluation} onTrust={noop} onBlock={noop} onOpenSettings={noop} />,
        ),
      ).toBe('');
    }

    const undecided = { ...base, state: 'untrusted' as const, dangerousItems: [...base.dangerousItems] };
    expect(needsFolderTrustDecision(undecided)).toBe(true);
    expect(needsFolderTrustDecision(null)).toBe(false);
    expect(needsFolderTrustDecision({ ...undecided, dangerousItems: [] })).toBe(false);
  });

  it('keeps zh/en folder trust keys aligned', () => {
    expect(Object.keys(en.folderTrust).sort()).toEqual(Object.keys(zh.folderTrust).sort());
    expect(Object.keys(en.folderTrust.risks).sort()).toEqual(Object.keys(zh.folderTrust.risks).sort());
  });
});
