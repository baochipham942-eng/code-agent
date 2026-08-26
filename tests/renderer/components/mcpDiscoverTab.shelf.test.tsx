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

describe('McpDiscoverTab unified grid cards', () => {
  afterEach(cleanup);

  it('keeps capability copy on the card and moves runtime details into the modal', () => {
    renderDiscover();

    const fetchCard = screen.getByTestId('mcp-discover-card-fetch');
    expect(fetchCard.textContent).toContain(findRecommendedMcpServer('fetch')!.description);
    expect(fetchCard.textContent).not.toContain('APP_SECRET');

    fireEvent.click(fetchCard);
    expect(screen.getByTestId('mcp-discover-runtime-fetch').textContent).toBe('UVX');
    expect(screen.getByTestId('mcp-discover-tools-fetch').textContent).toContain('fetch');
    expect(screen.getByText(discoverText.grid.tryIt)).toBeTruthy();
  });

  it('renders declared brand logos and keeps the Lucide fallback for entries without one', () => {
    renderDiscover();

    const exaCard = screen.getByTestId('mcp-discover-card-exa');
    const exaLogo = within(exaCard).getByRole('img', { name: 'Exa AI 搜索' });
    expect(exaLogo.parentElement?.className).toContain('h-7');
    expect(exaLogo.parentElement?.className).toContain('w-7');
    fireEvent.click(exaCard);
    const exaDetailLogo = within(screen.getByTestId('mcp-discover-detail-exa'))
      .getByRole('img', { name: 'Exa AI 搜索' });
    expect(exaDetailLogo.parentElement?.className).toContain('h-8');
    expect(exaDetailLogo.parentElement?.className).toContain('w-8');

    for (const [id, name] of [
      ['notion', 'Notion'],
      ['tencent-survey', '腾讯问卷'],
      ['tencent-weiyun', '腾讯微云'],
      ['puppeteer', 'Puppeteer'],
      ['deepwiki', 'DeepWiki'],
      ['tencent-map', '腾讯地图'],
      ['amap', '高德地图'],
    ]) {
      const card = screen.getByTestId(`mcp-discover-card-${id}`);
      expect(within(card).getByRole('img', { name })).toBeTruthy();
    }

    const fetchCard = screen.getByTestId('mcp-discover-card-fetch');
    expect(within(fetchCard).queryByRole('img')).toBeNull();
    const fallback = fetchCard.querySelector('svg');
    expect(fallback?.classList.contains('h-7')).toBe(true);
    expect(fallback?.classList.contains('w-7')).toBe(true);
  });

  it('shows install-after-connect for entries without a curated tool list', () => {
    renderDiscover();
    fireEvent.click(screen.getByTestId('mcp-discover-card-task_master'));

    expect(screen.getByTestId('mcp-discover-tools-task_master').textContent)
      .toContain(discoverText.toolsVisibleAfterInstall);
  });

  it('removes configured servers from discovery so the grid has one card per connector', () => {
    renderDiscover({ existingServerIds: new Set(['excel']) });

    expect(screen.queryByTestId('mcp-discover-card-excel')).toBeNull();
    expect(screen.getByTestId('mcp-discover-card-playwright')).toBeTruthy();
  });

  it('merges the read-only lark entry into the SaaS Feishu detail instead of rendering a second card', () => {
    renderDiscover();

    expect(screen.queryByTestId('mcp-discover-card-lark')).toBeNull();
  });

  it('shows every live-approved remote Tencent connector as not connected', () => {
    renderDiscover();

    for (const id of [
      'tencent-docs',
      'tencent-docs-oa',
      'tencent-survey',
      'tencent-weiyun',
      'tencent-map',
    ]) {
      expect(screen.getByTestId(`mcp-discover-card-${id}`).textContent)
        .toContain(discoverText.grid.notConnected);
    }
  });

  it('opens details first, then routes add through the prefilled editor callback', () => {
    const props = renderDiscover();
    fireEvent.click(screen.getByTestId('mcp-discover-card-excel'));
    fireEvent.click(screen.getByTestId('mcp-discover-add-excel'));

    expect(props.onAdd).toHaveBeenCalledTimes(1);
    expect(props.onAdd).toHaveBeenCalledWith(expect.objectContaining({
      id: 'excel',
      connection: expect.objectContaining({ type: 'stdio', command: 'npx' }),
    }));
    expect(props.onEnableBuiltin).not.toHaveBeenCalled();
  });

  it('routes a disabled built-in server to enable instead of add', () => {
    const props = renderDiscover();
    const exaCard = screen.getByTestId('mcp-discover-card-exa');
    fireEvent.click(exaCard);
    fireEvent.click(within(screen.getByRole('dialog')).getByText(discoverText.enable));

    expect(props.onEnableBuiltin).toHaveBeenCalledWith('exa');
    expect(props.onAdd).not.toHaveBeenCalled();
  });
});
