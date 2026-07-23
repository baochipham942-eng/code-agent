// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { on: () => () => {}, invokeDomain: (...args: unknown[]) => invokeDomain(...args) } }));
import { TeamRecipeDraftCard } from '../../../src/renderer/components/features/chat/ChatInput/TeamRecipeDraftCard';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';

describe('TeamRecipeDraftCard', () => {
  it('渲染专家团档位、成员任务与未知角色警告', () => {
    const html = renderToStaticMarkup(React.createElement(TeamRecipeDraftCard, { onResolved: () => {}, onDismiss: () => {}, drafts: [{ id: 'd1', name: '上线评审', description: 'd', lead: { roleId: '牧之', briefTemplate: '汇总 {topic}' }, members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }], unknownRoleNames: ['法务审核'] }] }));
    expect(html).toContain('专家团');
    expect(html).toContain('溯真');
    expect(html).toContain('调研 {topic}');
    expect(html).toContain('法务审核');
    expect(html).toContain('确认保存');
    expect(html).toContain('放弃');
  });

  // 2026-07-23 用户实测：草稿卡上只有裸花名（牧之/溯真），不知道各自是干什么的。
  // 职业数据在 agent registry 里一直有，卡片没接。
  it('成员和主理人都带上职业，查不到职业的角色只显示花名', () => {
    useAgentRegistryStore.setState({
      entries: [
        { id: '牧之', name: '牧之', description: '', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [], profession: '资深产品经理' },
        { id: '溯真', name: '溯真', description: '', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [], profession: '行业研究员' },
        { id: '小助手', name: '小助手', description: '', source: 'user', modelTier: 'balanced', readonly: false, tools: [] },
      ],
      isLoaded: true,
    });
    // 必须走客户端 render：renderToStaticMarkup 是 SSR 路径，zustand 在那条路上读
    // getInitialState（永远是空 entries），setState 的数据看不见，断言会天然假绿
    const { container } = render(<TeamRecipeDraftCard drafts={[{ id: 'd3', name: '上线评审', description: 'd', lead: { roleId: '牧之', briefTemplate: '汇总 {topic}' }, members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }, { roleId: '小助手', taskTemplate: '打杂 {topic}' }] }]} onResolved={() => {}} onDismiss={() => {}} />);
    const html = container.innerHTML;

    expect(html).toContain('资深产品经理');
    expect(html).toContain('行业研究员');
    // 主理人文案的两半都要在（占位符切分不能把句子切坏）
    expect(html).toContain('专家团 ·');
    expect(html).toContain('综述定稿');
    // 无职业的角色不许多出一个空的次要文本节点
    expect(html).toContain('小助手');
    expect(html).not.toContain('小助手</span><span class="truncate text-zinc-500">');
  });

  it('确认与放弃分别走 team 草稿 action', async () => {
    invokeDomain.mockResolvedValue({ success: true });
    const draft = { id: 'd2', name: '小组', description: 'd', members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }] };
    const { rerender } = render(<TeamRecipeDraftCard drafts={[draft]} onResolved={() => {}} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText('确认保存'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith('domain:team', 'confirmDraft', { draftId: 'd2' }));
    rerender(<TeamRecipeDraftCard drafts={[draft]} onResolved={() => {}} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText('放弃'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith('domain:team', 'rejectDraft', { draftId: 'd2' }));
  });
});
