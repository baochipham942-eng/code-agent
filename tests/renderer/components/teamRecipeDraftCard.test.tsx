// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { on: () => () => {}, invokeDomain: (...args: unknown[]) => invokeDomain(...args) } }));
import { TeamRecipeDraftCard } from '../../../src/renderer/components/features/chat/ChatInput/TeamRecipeDraftCard';

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
