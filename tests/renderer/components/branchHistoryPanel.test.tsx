// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_DOMAINS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  invokeDomain: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: mocks.invokeDomain,
  },
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { BranchHistoryPanel } from '../../../src/renderer/components/features/chat/BranchHistoryPanel';
import type { SessionExportEnvelopeV2 } from '../../../src/shared/contract/sessionForkPortability';

const replay = {
  lineage: {
    branchId: 'branch-child',
    sessionId: 'child',
    ownerUserId: 'owner-1',
    projectId: 'project-1',
    rootBranchId: 'branch-root',
    parentBranchId: 'branch-root',
    parentSessionId: 'parent',
    forkId: 'fork-1',
    anchorEntryId: 'entry-a1',
    createdAt: 1,
  },
  messages: [
    {
      ordinal: 0,
      entryId: 'entry-u1',
      projectedMessageId: 'child-u1',
      sourceSessionId: 'parent',
      sourceMessageId: 'u1',
      aliasKind: 'fork_copy',
      message: { id: 'child-u1', role: 'user', content: 'question', timestamp: 1 },
    },
    {
      ordinal: 1,
      entryId: 'entry-a1',
      projectedMessageId: 'child-a1',
      sourceSessionId: 'parent',
      sourceMessageId: 'a1',
      aliasKind: 'fork_copy',
      message: { id: 'child-a1', role: 'assistant', content: 'answer', timestamp: 2 },
    },
  ],
  openRewindIds: ['rewind-open'],
  ledgerEventCount: 5,
} as const;

function envelope(projectId = 'project-1'): SessionExportEnvelopeV2 {
  return {
    schema: 'neo.session-export',
    version: 2,
    exportId: 'export-1',
    exportedAt: 10,
    ownerScopeId: 'owner-1',
    projectId,
    rootSessionId: 'child',
    mode: 'subtree',
    sessions: [],
    messages: [],
    lineage: {
      schema: 'neo.fork-lineage',
      version: 1,
      ownerScopeId: 'owner-1',
      projectId,
      rootSessionId: 'child',
      createdAt: 10,
      nodes: [],
      messageMappings: [],
      payloadDigest: 'lineage-digest',
    },
    payloadDigest: 'export-digest',
  };
}

describe('BranchHistoryPanel', () => {
  beforeEach(() => {
    mocks.invokeDomain.mockReset();
    mocks.invokeDomain.mockImplementation(async (_domain, action) => {
      if (action === 'replayConversationBranch') return replay;
      if (action === 'auditConversationLineage') {
        return {
          branch: replay.lineage,
          status: 'healthy',
          issueDigest: 'healthy-digest',
          issues: [],
          quarantineEventId: null,
          repairOverrideEventId: null,
        };
      }
      if (action === 'listConversationEvaluationAttributions') return [];
      throw new Error(`unexpected action: ${action}`);
    });
  });

  afterEach(() => cleanup());

  it('loads durable replay, open rewind state, audit health and latest-message provenance', async () => {
    mocks.invokeDomain.mockImplementation(async (_domain, action, payload) => {
      if (action === 'replayConversationBranch') return replay;
      if (action === 'auditConversationLineage') {
        return {
          branch: replay.lineage,
          status: 'quarantined',
          issueDigest: 'issue-digest',
          issues: [{ code: 'EVENT_CHAIN_MISMATCH', detail: 'broken', branchId: 'branch-child' }],
          quarantineEventId: 'quarantine-1',
          repairOverrideEventId: null,
        };
      }
      if (action === 'listConversationEvaluationAttributions') return [];
      if (action === 'traceConversationProvenance') {
        expect(payload).toEqual({ sessionId: 'child', messageId: 'child-a1' });
        return {
          entry: {
            id: 'entry-a1',
            ownerUserId: 'owner-1',
            projectId: 'project-1',
            sourceSessionId: 'parent',
            sourceMessageId: 'a1',
            payloadDigest: 'entry-digest',
            message: replay.messages[1].message,
            provenance: {},
            createdAt: 2,
          },
          canonicalSource: { sessionId: 'parent', messageId: 'a1' },
          aliases: [],
          branchPath: [replay.lineage],
        };
      }
      throw new Error(`unexpected action: ${action}`);
    });

    render(
      <BranchHistoryPanel
        sessionId="child"
        projectId="project-1"
        onOpenSession={vi.fn()}
      />,
    );

    expect((await screen.findByTestId('branch-replay-summary')).textContent).toContain(
      '2 条消息 · 1 个未恢复回退 · 5 个账本事件',
    );
    expect(screen.getByTestId('branch-audit-status').textContent).toContain('已隔离');
    expect(mocks.invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.SESSION,
      'replayConversationBranch',
      {
        sessionId: 'child',
        options: { includeRewound: true },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: '追溯消息来源' }));
    expect((await screen.findByTestId('branch-provenance')).textContent).toContain(
      'parent / a1',
    );
  });

  it('exports inside the returned exact project boundary, then searches and reads its tree', async () => {
    const exported = envelope();
    mocks.invokeDomain.mockImplementation(async (_domain, action, payload) => {
      if (action === 'replayConversationBranch') return replay;
      if (action === 'auditConversationLineage') {
        return {
          branch: replay.lineage,
          status: 'healthy',
          issueDigest: 'healthy-digest',
          issues: [],
          quarantineEventId: null,
          repairOverrideEventId: null,
        };
      }
      if (action === 'listConversationEvaluationAttributions') return [];
      if (action === 'exportSessionFork') return exported;
      if (action === 'readSessionForkTree') {
        expect(payload).toEqual({ exportId: 'export-1', projectId: 'project-1' });
        return {
          sessionId: 'child',
          parentSessionId: null,
          depth: 0,
          ordinal: 0,
          createdAt: 10,
          children: [],
        };
      }
      if (action === 'searchSessionForkExports') {
        expect(payload).toEqual({
          exportId: 'export-1',
          projectId: 'project-1',
          query: 'answer',
        });
        return [{
          id: 'doc-child',
          sessionId: 'child',
          rootSessionId: 'child',
          parentSessionId: null,
          depth: 0,
          title: 'Child',
          engineKind: 'native',
          workspaceMode: 'shared_current',
          messageCount: 2,
          createdAt: 10,
          searchText: 'answer',
        }];
      }
      throw new Error(`unexpected action: ${action}`);
    });

    render(
      <BranchHistoryPanel
        sessionId="child"
        projectId="project-1"
        onOpenSession={vi.fn()}
      />,
    );
    await screen.findByTestId('branch-replay-summary');
    fireEvent.click(screen.getByRole('button', { name: '创建便携导出' }));

    expect((await screen.findByTestId('branch-export-summary')).textContent).toContain(
      'export-1 · Project project-1',
    );
    expect(mocks.invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.SESSION,
      'exportSessionFork',
      expect.objectContaining({ sessionId: 'child', mode: 'subtree' }),
    );

    fireEvent.change(screen.getByLabelText('搜索当前导出'), { target: { value: 'answer' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索分支' }));
    expect((await screen.findByTestId('branch-export-search-results')).textContent).toContain('Child');
    expect(screen.getByTestId('branch-export-tree').textContent).toContain('child');
  });

  it('requires a parsed preview, exact project match and an explicit second confirmation to import', async () => {
    const imported = {
      importId: 'import-1',
      sourceExportId: 'export-1',
      rootSessionId: 'imported-root',
      sessionIdMap: { child: 'imported-root' },
      messageIdMap: {},
      forkIdMap: {},
      importedAt: 20,
    };
    mocks.invokeDomain.mockImplementation(async (_domain, action, payload) => {
      if (action === 'replayConversationBranch') return replay;
      if (action === 'auditConversationLineage') {
        return {
          branch: replay.lineage,
          status: 'healthy',
          issueDigest: 'healthy-digest',
          issues: [],
          quarantineEventId: null,
          repairOverrideEventId: null,
        };
      }
      if (action === 'listConversationEvaluationAttributions') return [];
      if (action === 'importSessionFork') {
        expect(payload).toEqual({
          envelope: envelope(),
          targetProjectId: 'project-1',
          namespace: 'review-copy',
          allowProjectRemap: false,
        });
        return imported;
      }
      throw new Error(`unexpected action: ${action}`);
    });
    const onOpenSession = vi.fn();

    render(
      <BranchHistoryPanel
        sessionId="child"
        projectId="project-1"
        onOpenSession={onOpenSession}
      />,
    );
    await screen.findByTestId('branch-replay-summary');

    fireEvent.change(screen.getByLabelText('粘贴便携 JSON'), {
      target: { value: JSON.stringify(envelope()) },
    });
    fireEvent.change(screen.getByLabelText('导入命名空间'), {
      target: { value: 'review-copy' },
    });
    expect(screen.queryByRole('button', { name: '确认导入到当前 Project' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '校验导入内容' }));
    expect((await screen.findByTestId('branch-import-preview')).textContent).toContain(
      'export-1 · Project project-1',
    );
    fireEvent.click(screen.getByRole('button', { name: '确认导入到当前 Project' }));

    await waitFor(() => expect(mocks.invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.SESSION,
      'importSessionFork',
      expect.anything(),
    ));
    fireEvent.click(screen.getByRole('button', { name: '打开导入任务' }));
    expect(onOpenSession).toHaveBeenCalledWith('imported-root');
  });

  it('fails closed when the current session has no exact Project boundary', async () => {
    render(
      <BranchHistoryPanel
        sessionId="child"
        projectId={null}
        onOpenSession={vi.fn()}
      />,
    );
    await screen.findByTestId('branch-replay-summary');

    fireEvent.change(screen.getByLabelText('粘贴便携 JSON'), {
      target: { value: JSON.stringify(envelope()) },
    });
    fireEvent.change(screen.getByLabelText('导入命名空间'), {
      target: { value: 'review-copy' },
    });
    fireEvent.click(screen.getByRole('button', { name: '校验导入内容' }));

    expect((await screen.findByTestId('branch-import-boundary-error')).textContent).toContain(
      '当前任务没有可确认的 Project 边界',
    );
    expect(screen.queryByRole('button', { name: '确认导入到当前 Project' })).toBeNull();
    expect(mocks.invokeDomain).not.toHaveBeenCalledWith(
      IPC_DOMAINS.SESSION,
      'importSessionFork',
      expect.anything(),
    );
  });

  it('does not expose confirmation for a different source Project', async () => {
    render(
      <BranchHistoryPanel
        sessionId="child"
        projectId="project-2"
        onOpenSession={vi.fn()}
      />,
    );
    await screen.findByTestId('branch-replay-summary');

    fireEvent.change(screen.getByLabelText('粘贴便携 JSON'), {
      target: { value: JSON.stringify(envelope('project-1')) },
    });
    fireEvent.change(screen.getByLabelText('导入命名空间'), {
      target: { value: 'review-copy' },
    });
    fireEvent.click(screen.getByRole('button', { name: '校验导入内容' }));

    expect((await screen.findByTestId('branch-import-boundary-error')).textContent).toContain(
      '导出属于 Project project-1，当前任务属于 Project project-2',
    );
    expect(screen.queryByRole('button', { name: '确认导入到当前 Project' })).toBeNull();
  });
});
