// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const selectedSkillIds = vi.hoisted<string[]>(() => []);
const selectCapability = vi.hoisted(() => vi.fn((capability: { id: string }) => {
  selectedSkillIds.push(capability.id);
}));

const registryState = {
  skills: [{ kind: 'skill', id: 'alpha', label: 'Alpha skill', description: '写作', selected: false, mounted: true, libraryId: 'builtin' }],
  connectors: [] as any[],
  mcpServers: [] as any[],
};
vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({ ...registryState, items: [] }),
}));
const agentRegistryState = { entries: [] as any[] };
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: (selector: (state: typeof agentRegistryState) => unknown) => selector(agentRegistryState),
  isPanelVisibleAgent: () => true,
}));
const appState = {
  activeAgentId: null as string | null,
  setActiveAgentId: vi.fn(),
  openCapabilityHub: vi.fn(),
};
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});
import { InputAddMenu } from '../../../src/renderer/components/features/chat/ChatInput/InputAddMenu';

beforeEach(() => {
  selectedSkillIds.splice(0);
  registryState.connectors = [];
  registryState.mcpServers = [];
  agentRegistryState.entries = [];
  appState.activeAgentId = null;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('InputAddMenu 能力入口', () => {
  it('从加号菜单展开技能、渲染条目并选择到当前 turn 后关闭菜单', () => {
    render(
      <InputAddMenu
        onFileSelect={vi.fn()}
        onSelectCapability={selectCapability}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多输入选项' }));
    fireEvent.click(screen.getByRole('button', { name: /技能/ }));

    // 先断言有能力行，再断言选择副作用，避免空 mock 导致假绿。
    expect(screen.getByText('Alpha skill')).toBeTruthy();
    fireEvent.click(screen.getByText('Alpha skill'));
    expect(selectedSkillIds).toContain('alpha');
    expect(screen.queryByText('Alpha skill')).toBeNull();
  });

  it('专家声明的可选连接器：菜单里标明是谁推荐的、默认关着', () => {
    registryState.mcpServers = [{ kind: 'mcp', id: 'lark', label: '飞书', selected: false, status: 'connected', enabled: true }];
    appState.activeAgentId = 'weekly';
    agentRegistryState.entries = [{
      id: 'weekly',
      name: '周报专家',
      connectors: [{ id: 'lark', level: 'optional' }],
    }];

    render(<InputAddMenu onFileSelect={vi.fn()} onSelectCapability={selectCapability} />);
    fireEvent.click(screen.getByRole('button', { name: '更多输入选项' }));
    fireEvent.click(screen.getByRole('button', { name: /连接器/ }));

    expect(screen.getByText('周报专家 推荐 · 默认关')).toBeTruthy();
  });

  it('专家声明的核心连接器不在菜单里标推荐（它默认开、已在底栏露出）', () => {
    registryState.mcpServers = [{ kind: 'mcp', id: 'lark', label: '飞书', selected: false, status: 'connected', enabled: true }];
    appState.activeAgentId = 'weekly';
    agentRegistryState.entries = [{
      id: 'weekly',
      name: '周报专家',
      connectors: [{ id: 'lark', level: 'core' }],
    }];

    render(<InputAddMenu onFileSelect={vi.fn()} onSelectCapability={selectCapability} />);
    fireEvent.click(screen.getByRole('button', { name: '更多输入选项' }));
    fireEvent.click(screen.getByRole('button', { name: /连接器/ }));

    expect(screen.getByText('飞书')).toBeTruthy();
    expect(screen.queryByText(/推荐 · 默认关/)).toBeNull();
  });
});
