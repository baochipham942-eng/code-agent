// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { findRecommendedMcpServer, getBuiltinMcpCatalogPayload } from '../../../src/shared/constants/mcpCatalog';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
}));

import { McpDiscoverTab, type McpDiscoverTabProps } from '../../../src/renderer/components/features/settings/tabs/McpDiscoverTab';

const discoverText = zh.settings.mcp.discover;

function renderDiscover(overrides: Partial<McpDiscoverTabProps> = {}) {
  const props: McpDiscoverTabProps = {
    catalog: getBuiltinMcpCatalogPayload(),
    existingServerIds: new Set<string>(),
    enabledServerIds: new Set<string>(),
    canManageMcp: true,
    actionLoading: new Set<string>(),
    onAdd: vi.fn(),
    onEnableBuiltin: vi.fn(),
    ...overrides,
  };
  render(React.createElement(McpDiscoverTab, props));
  return props;
}

describe('McpDiscoverTab 货架卡', () => {
  afterEach(cleanup);

  it('按 connection/builtin 推导运行时徽标：NPX / UVX / 远程 / 内置', () => {
    renderDiscover();

    expect(screen.getByTestId('mcp-discover-runtime-playwright').textContent).toBe('NPX');
    expect(screen.getByTestId('mcp-discover-runtime-fetch').textContent).toBe('UVX');
    expect(screen.getByTestId('mcp-discover-runtime-notion').textContent).toBe(discoverText.runtimeRemote);
    expect(screen.getByTestId('mcp-discover-runtime-exa').textContent).toBe(discoverText.runtimeBuiltin);
  });

  it('卡片渲染一句描述与凭证提示', () => {
    renderDiscover();

    const fetchCard = screen.getByTestId('mcp-discover-card-fetch');
    expect(fetchCard.textContent).toContain(findRecommendedMcpServer('fetch')!.description);
    expect(fetchCard.textContent).toContain(discoverText.noConfig);

    const exaCard = screen.getByTestId('mcp-discover-card-exa');
    expect(exaCard.textContent).toContain('EXA_API_KEY');
  });

  it('展开箭头显示「N 个工具」与工具名列表；无静态清单的显示「安装后可见」占位', () => {
    renderDiscover();

    // fetch 有静态策展清单
    fireEvent.click(screen.getByTestId('mcp-discover-expand-fetch'));
    const fetchTools = screen.getByTestId('mcp-discover-tools-fetch');
    const fetchEntry = findRecommendedMcpServer('fetch')!;
    expect(fetchTools.textContent).toContain(`${fetchEntry.tools!.length}${discoverText.toolsCountSuffix}`);
    expect(fetchTools.textContent).toContain('fetch');

    // task_master 没填静态清单 → 占位
    fireEvent.click(screen.getByTestId('mcp-discover-expand-task_master'));
    expect(screen.getByTestId('mcp-discover-tools-task_master').textContent).toContain(
      discoverText.toolsVisibleAfterInstall,
    );

    // 再点一次收起
    fireEvent.click(screen.getByTestId('mcp-discover-expand-fetch'));
    expect(screen.queryByTestId('mcp-discover-tools-fetch')).toBeNull();
  });

  it('已配置过的 server 显示「已添加」态，不给重复添加按钮', () => {
    renderDiscover({ existingServerIds: new Set(['excel']) });

    expect(screen.getByTestId('mcp-discover-added-excel').textContent).toContain(discoverText.added);
    expect(screen.queryByTestId('mcp-discover-add-excel')).toBeNull();
    // 未配置的条目仍有添加按钮
    expect(screen.getByTestId('mcp-discover-add-playwright')).toBeTruthy();
  });

  it('「添加」走预填流程：回调携带目录条目（含 connection 预填模板），不直接写库', () => {
    const props = renderDiscover();

    const excelCard = screen.getByTestId('mcp-discover-card-excel');
    fireEvent.click(within(excelCard).getByText(discoverText.add));

    expect(props.onAdd).toHaveBeenCalledTimes(1);
    expect(props.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'excel',
        connection: expect.objectContaining({ type: 'stdio', command: 'npx' }),
      }),
    );
    expect(props.onEnableBuiltin).not.toHaveBeenCalled();
  });

  it('内置未启用的 server 走「启用」而非「添加」', () => {
    const props = renderDiscover();

    const exaCard = screen.getByTestId('mcp-discover-card-exa');
    expect(within(exaCard).queryByText(discoverText.add)).toBeNull();
    fireEvent.click(within(exaCard).getByText(discoverText.enable));

    expect(props.onEnableBuiltin).toHaveBeenCalledWith('exa');
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it('内置已启用的 server 显示「已添加」态', () => {
    renderDiscover({
      existingServerIds: new Set(['exa']),
      enabledServerIds: new Set(['exa']),
    });

    expect(screen.getByTestId('mcp-discover-added-exa').textContent).toContain(discoverText.added);
  });
});
