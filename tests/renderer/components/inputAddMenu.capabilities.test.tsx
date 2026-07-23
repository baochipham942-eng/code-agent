// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const selectedSkillIds = vi.hoisted<string[]>(() => []);
const selectCapability = vi.hoisted(() => vi.fn((capability: { id: string }) => {
  selectedSkillIds.push(capability.id);
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({
    skills: [{ kind: 'skill', id: 'alpha', label: 'Alpha skill', description: '写作', selected: false, mounted: true, libraryId: 'builtin' }],
    connectors: [],
    mcpServers: [],
    items: [],
  }),
}));
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: () => [],
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => null,
}));
vi.mock('../../../src/renderer/stores/modeStore', () => ({
  useModeStore: () => 'ask',
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});
import { InputAddMenu } from '../../../src/renderer/components/features/chat/ChatInput/InputAddMenu';

beforeEach(() => {
  selectedSkillIds.splice(0);
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('InputAddMenu 能力入口', () => {
  it('从加号菜单展开技能、渲染条目并选择到当前 turn 后关闭菜单', () => {
    render(
      <InputAddMenu
        onSlashCommand={vi.fn()}
        onFileSelect={vi.fn()}
        memoryMode="auto"
        onToggleMemory={vi.fn()}
        onOpenLibrary={vi.fn()}
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
});
