// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderTrustDialog, needsFolderTrustDecision } from '../../../src/renderer/components/FolderTrustDialog';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const noop = () => {};

const dangerousEvaluation = {
  state: 'untrusted' as const,
  canonicalRealpath: '/real/project',
  displayPath: '/tmp/link-project',
  identityChanged: false,
  dangerousItems: [
    {
      kind: 'project-hooks',
      displayPath: '.code-agent/hooks/hooks.json',
      risk: 'execution',
      gated: true,
    },
  ],
  blockedItems: [],
};

describe('FolderTrustDialog', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

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
              risk: 'execution',
              gated: true,
            },
            {
              kind: 'project-mcp-local',
              displayPath: '.code-agent/mcp.local.json',
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
    expect(Object.keys(en.folderTrust.items).sort()).toEqual(Object.keys(zh.folderTrust.items).sort());
  });

  // N-FOLDERTRUST-RISKTIER ①：只放了一个 CLAUDE.md 的目录不再打扰用户
  it('只有不拦的项（说明文件/快捷指令）时不弹窗', () => {
    const evaluation = {
      state: 'untrusted' as const,
      canonicalRealpath: '/real/project',
      displayPath: '/real/project',
      identityChanged: false,
      dangerousItems: [
        { kind: 'agent-instructions', displayPath: 'CLAUDE.md', risk: 'prompt', gated: false },
        { kind: 'project-commands', displayPath: '.code-agent/commands', risk: 'prompt', gated: false, count: 3 },
      ],
      blockedItems: [],
    };
    expect(needsFolderTrustDecision(evaluation)).toBe(false);
    expect(
      renderToStaticMarkup(
        <FolderTrustDialog evaluation={evaluation} onTrust={noop} onBlock={noop} onOpenSettings={noop} />,
      ),
    ).toBe('');
  });

  // N-FOLDERTRUST-RISKTIER ②：每项说清「会发生什么」，且不出现工程词
  it('弹窗只列会自动生效的项，用人话说明后果与代价', () => {
    const html = renderToStaticMarkup(
      <FolderTrustDialog
        evaluation={{
          state: 'untrusted',
          canonicalRealpath: '/real/project',
          displayPath: '/real/project',
          identityChanged: false,
          contentChanged: true,
          dangerousItems: [
            { kind: 'project-hooks', displayPath: '.code-agent/hooks/hooks.json', risk: 'execution', gated: true, count: 3 },
            { kind: 'project-mcp', displayPath: '.code-agent/mcp.json', risk: 'mcp', gated: true, count: 1 },
            { kind: 'agent-instructions', displayPath: 'CLAUDE.md', risk: 'prompt', gated: false },
          ],
          blockedItems: [],
        }}
        onTrust={noop}
        onBlock={noop}
        onOpenSettings={noop}
      />,
    );

    expect(html).toContain(zh.folderTrust.items['project-hooks'].replace('{count}', '3'));
    expect(html).toContain(zh.folderTrust.items['project-mcp'].replace('{count}', '1'));
    expect(html).toContain(zh.folderTrust.costNote);
    expect(html).toContain(zh.folderTrust.contentChanged);
    // 不拦的项不进清单（它们本来就会加载，问了也没有可决定的东西）
    expect(html).not.toContain('CLAUDE.md');
    // 工程词不出现在用户面（路径里的小写 mcp/hooks 是文件名，不是给人读的标签）
    for (const jargon of ['MCP', 'Agent 定义', 'Skill 定义', '命令执行', 'hook 脚本']) {
      expect(html).not.toContain(jargon);
    }
  });

  it('阻止是聚焦的主按钮，信任是弱按钮，关闭与 Esc 也落到阻止侧', () => {
    const onTrust = vi.fn();
    const onBlock = vi.fn();
    render(
      <FolderTrustDialog
        evaluation={dangerousEvaluation}
        onTrust={onTrust}
        onBlock={onBlock}
        onOpenSettings={noop}
      />,
    );

    const block = screen.getByRole('button', { name: zh.folderTrust.block });
    const trust = screen.getByRole('button', { name: zh.folderTrust.trust });
    expect(document.activeElement).toBe(block);
    expect(block.className).toContain('bg-amber-600');
    expect(trust.className).not.toContain('bg-amber-600');

    fireEvent.click(block);
    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(onTrust).not.toHaveBeenCalled();

    onBlock.mockClear();
    fireEvent.click(trust);
    expect(onTrust).toHaveBeenCalledTimes(1);
    expect(onBlock).not.toHaveBeenCalled();

    onTrust.mockClear();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(onTrust).not.toHaveBeenCalled();
  });

  it('危险项清单固定高度；溢出时显示渐隐提示，滚到底后提示消失', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(224);
    const { container } = render(
      <FolderTrustDialog
        evaluation={{
          ...dangerousEvaluation,
          dangerousItems: Array.from({ length: 5 }, (_, index) => ({
            ...dangerousEvaluation.dangerousItems[0],
            kind: `project-config-${index}`,
            displayPath: `.project/config-${index}.json`,
          })),
        }}
        onTrust={noop}
        onBlock={noop}
        onOpenSettings={noop}
      />,
    );

    expect(container.innerHTML).toContain('max-h-56');
    expect(container.innerHTML).toContain('overflow-y-scroll');
    expect(container.innerHTML).toContain('scrollbar-band');
    expect(container.innerHTML).toContain('.project/config-4.json');
    await waitFor(() => expect(screen.getByTestId('folder-trust-more-hint')).toBeTruthy());

    const scroll = screen.getByTestId('folder-trust-danger-scroll');
    Object.defineProperty(scroll, 'scrollTop', { configurable: true, value: 176 });
    fireEvent.scroll(scroll);
    await waitFor(() => expect(screen.queryByTestId('folder-trust-more-hint')).toBeNull());
  });
});
