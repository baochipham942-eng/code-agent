import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidebarSessionItem } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

describe('SidebarSessionItem Evidence Control badge', () => {
  it('renders evidence trust from trajectory quality summary without opening replay', () => {
    const session = {
      id: 'session-evidence',
      title: 'Evidence Review Session',
      type: 'chat',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 4,
      turnCount: 2,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      workingDirectory: '/repo/code-agent',
    } as any;

    const html = renderToStaticMarkup(
      <SidebarSessionItem
        session={session}
        unreadSessionIds={new Set()}
        automationSummariesBySessionId={{}}
        currentSessionId={null}
        selectedSessionIds={new Set()}
        pinnedSessionIds={new Set()}
        renamingId={null}
        sessionRuntimes={new Map()}
        backgroundTaskMap={new Map()}
        sessionStates={{}}
        hasPendingApprovalForSession={() => false}
        searchQuery=""
        messageSearchHitsBySessionId={{}}
        replayEvidenceBySessionId={new Map()}
        canOpenSessionReplay={true}
        reviewItemsBySessionId={{}}
        trajectoryQualityBySessionId={{
          'session-evidence': {
            sessionId: 'session-evidence',
            dataSource: 'telemetry',
            quality: {
              tier: 'G1',
              passed: false,
              exportReady: false,
              failures: ['missing_tool_result'],
              warnings: [],
              classification: {
                taskKind: 'coding',
                datasetRole: 'diagnostic',
                reason: 'incomplete_or_historical_replay',
                labels: ['diagnostic', 'coding', 'g1'],
              },
              metrics: {
                turnCount: 2,
                modelCallCount: 1,
                toolCallCount: 1,
                toolResultCount: 0,
                eventCount: 0,
                toolDefinitionCount: 1,
                finalAnswerPresent: true,
                pendingToolResultCount: 0,
              },
            },
            collection: {
              schemaVersion: 1,
              intent: 'historical_diagnostic',
              taskKind: 'coding',
              datasetRole: 'diagnostic',
              datasetVersion: 'agent-trajectory-v1',
              source: 'quality_gate',
              reason: 'incomplete_or_historical_replay',
              failureTags: ['missing_tool_result'],
              labels: ['diagnostic', 'coding'],
              createdAt: 1,
              updatedAt: 2,
            },
            evidenceControl: {
              schemaVersion: 1,
              trustLevel: 'partial',
              generatedAt: 3,
              totalItems: 3,
              totalEvidenceRefs: 4,
              exportSafeItems: 3,
              blockedItems: 0,
              staleItems: 1,
              conflictItems: 1,
              bySource: {
                verification: 1,
                browser_computer: 1,
                trajectory: 0,
                background_recovery: 1,
              },
              byStatus: {
                passed: 1,
                observed: 1,
                recovered: 1,
              },
              gaps: ['stale evidence present at /Users/linchen/private.png?token=secret-token cookie=cookie-secret'],
              conflicts: ['base64,abcdef conflict localStorage=local-secret'],
            },
          },
        }}
        multiSelectMode={false}
        hoveredSession={null}
        renameValue=""
        renameInputRef={React.createRef<HTMLInputElement>()}
        setHoveredSession={vi.fn()}
        setRenameValue={vi.fn()}
        handleSelectSession={vi.fn()}
        handleContextMenu={vi.fn()}
        handleRenameSubmit={vi.fn()}
        handleRenameKeyDown={vi.fn()}
        handleDoubleClick={vi.fn()}
        handleOpenSessionReplay={vi.fn()}
        handleOpenSessionAssets={vi.fn()}
        handleOpenReplayEvidence={vi.fn()}
        handleSelectMessageSearchHit={vi.fn()}
        handleArchiveSession={vi.fn()}
      />,
    );

    expect(html).toContain('G1 · Diag');
    expect(html).toContain('EV partial');
    expect(html).toContain('Evidence Control partial');
    expect(html).toContain('3 items · 4 refs');
    expect(html).toContain('blocked 0 · stale 1 · conflicts 1');
    expect(html).toContain('stale evidence present');
    expect(html).not.toContain('/Users/linchen');
    expect(html).not.toContain('secret-token');
    expect(html).not.toContain('base64,abcdef');
    expect(html).not.toContain('cookie-secret');
    expect(html).not.toContain('local-secret');
  });
});
