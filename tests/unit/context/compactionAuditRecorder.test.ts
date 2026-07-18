import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';

const recorderMocks = vi.hoisted(() => ({
  db: {
    isReady: true,
    insertCompactionSnapshot: vi.fn(),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => recorderMocks.db,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => recorderMocks.logger,
}));

import {
  buildCompactionAuditSummary,
  recordCompactionAuditSnapshot,
} from '../../../src/host/context/compactionAuditRecorder';

function message(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: Number(id.replace(/\D/g, '') || 1) };
}

function compactionResult() {
  const messages = [
    message('m1', 'user', 'Read /Users/linchen/Downloads/ai/code-agent/src/host/context/compactionService.ts'),
    message('m2', 'assistant', 'TODO: preserve validation warnings.'),
    message('m3', 'tool', 'AssertionError: expected warnings to include basename coverage.'),
    message('m4', 'assistant', 'recent answer'),
  ];
  const summaryMessage = message('compact-summary-1000-0', 'system', '[Context Handoff]\n\nSummary body');

  return {
    success: true,
    plan: {
      sessionId: 'session-1',
      source: 'manual_current' as const,
      anchorMessageId: 'm4',
      preserveRecentCount: 1,
      messages,
      compactedMessages: messages.slice(0, 3),
      preservedMessages: messages.slice(3),
      manifest: {
        compactedMessageIds: ['m1', 'm2', 'm3'],
        preservedMessageIds: ['m4'],
        filePaths: ['/Users/linchen/Downloads/ai/code-agent/src/host/context/compactionService.ts'],
        files: [{ path: '/Users/linchen/Downloads/ai/code-agent/src/host/context/compactionService.ts' }],
        commands: [{ command: 'npm test', success: false }],
        errors: [{ text: 'AssertionError: expected warnings to include basename coverage.' }],
        todos: [{ text: 'TODO: preserve validation warnings.' }],
        openWork: [{ text: 'TODO: preserve validation warnings.' }],
        artifacts: [{ path: '/Users/linchen/Downloads/ai/code-agent/tmp/report.json', source: 'tool_result' }],
        dataFingerprintText: 'Data fingerprint: stable.',
      },
      originalTokens: 900,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
    },
    summary: 'Summary body',
    summaryMessage,
    newMessages: [summaryMessage, messages[3]],
    block: {
      summaryVersion: 1,
      source: 'manual_current' as const,
      anchorMessageId: 'm4',
      provider: 'moonshot',
      model: 'kimi-k2.5',
      warnings: ['Summary missed survivor manifest items; deterministic manifest was prepended.'],
      survivorManifest: {
        sessionId: 'session-1',
        source: 'manual_current' as const,
        anchorMessageId: 'm4',
        preserveRecentCount: 1,
        compactedMessageIds: ['m1', 'm2', 'm3'],
        preservedMessageIds: ['m4'],
        files: [{ path: '/Users/linchen/Downloads/ai/code-agent/src/host/context/compactionService.ts' }],
        commands: [{ label: 'npm test', detail: 'exit=1', severity: 'error' as const }],
        errors: [{ label: 'Unresolved error', detail: 'AssertionError: expected warnings to include basename coverage.', severity: 'error' as const }],
        openWork: [{ label: 'Open work', detail: 'TODO: preserve validation warnings.', severity: 'warning' as const }],
        artifacts: [{ path: '/Users/linchen/Downloads/ai/code-agent/tmp/report.json' }],
        dataFingerprint: 'Data fingerprint: stable.',
      },
    },
    beforeTokens: 1200,
    afterTokens: 420,
    savedTokens: 780,
    validation: {
      ok: false,
      emptyOrWhitespace: false,
      truncated: false,
      overBudget: false,
      missingPaths: ['/Users/linchen/Downloads/ai/code-agent/src/host/context/compactionService.ts'],
      missingErrors: ['Unresolved error: AssertionError: expected warnings to include basename coverage.'],
      missingOpenWork: ['Open work: TODO: preserve validation warnings.'],
      warnings: ['Path compactionService.ts was covered only by basename with needs re-read instruction.'],
    },
    summaryModel: {
      provider: 'moonshot',
      model: 'kimi-k2.5',
      useMainModel: false,
    },
    warnings: ['Summary missed survivor manifest items; deterministic manifest was prepended.'],
  };
}

describe('compactionAuditRecorder', () => {
  beforeEach(() => {
    delete process.env.CODE_AGENT_CLI_MODE;
    delete process.env.CODE_AGENT_WEB_MODE;
    recorderMocks.db.isReady = true;
    recorderMocks.db.insertCompactionSnapshot.mockReset();
    recorderMocks.db.insertCompactionSnapshot.mockReturnValue({
      id: 'compact_1',
      createdAt: 1234,
      byteSize: 100,
    });
    recorderMocks.logger.warn.mockReset();
  });

  it('builds the structured post-summary audit payload', () => {
    const summary = buildCompactionAuditSummary(compactionResult());

    expect(summary).toMatchObject({
      type: 'compact_messages_with_summary_audit',
      success: true,
      summaryVersion: 1,
      source: 'manual_current',
      provider: 'moonshot',
      model: 'kimi-k2.5',
      modelConfig: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
      },
      validation: {
        ok: false,
        missing: {
          paths: ['/Users/linchen/Downloads/ai/code-agent/src/host/context/compactionService.ts'],
          errors: ['Unresolved error: AssertionError: expected warnings to include basename coverage.'],
          openWork: ['Open work: TODO: preserve validation warnings.'],
        },
        warnings: ['Path compactionService.ts was covered only by basename with needs re-read instruction.'],
      },
      survivorManifestCounts: {
        compactedMessages: 3,
        preservedMessages: 1,
        files: 1,
        commands: 1,
        errors: 1,
        openWork: 1,
        artifacts: 1,
        hasDataFingerprint: true,
      },
    });
  });

  it('writes a compaction audit snapshot when the database sink is ready', () => {
    const result = compactionResult();

    recordCompactionAuditSnapshot({
      result,
      usagePercent: 0.82,
      createdAt: 1700,
    });

    expect(recorderMocks.db.insertCompactionSnapshot).toHaveBeenCalledTimes(1);
    expect(recorderMocks.db.insertCompactionSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        strategy: 'manual_current',
        preMessageCount: 4,
        postMessageCount: 2,
        preTokens: 1200,
        postTokens: 420,
        savedTokens: 780,
        usagePercent: 0.82,
        createdAt: 1700,
        preMessagesSummary: expect.objectContaining({
          type: 'compact_messages_with_summary_pre_audit',
          compactedMessageCount: 3,
          preservedMessageCount: 1,
        }),
        postMessagesSummary: expect.objectContaining({
          type: 'compact_messages_with_summary_audit',
          summaryVersion: 1,
          provider: 'moonshot',
          model: 'kimi-k2.5',
          survivorManifestCounts: expect.objectContaining({
            files: 1,
            commands: 1,
            errors: 1,
            openWork: 1,
          }),
        }),
      }),
    );
    expect(recorderMocks.logger.warn).not.toHaveBeenCalled();
  });

  it('uses the main database sink in web mode even when CLI mode is enabled', () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    process.env.CODE_AGENT_WEB_MODE = 'true';

    recordCompactionAuditSnapshot({ result: compactionResult() });

    expect(recorderMocks.db.insertCompactionSnapshot).toHaveBeenCalledTimes(1);
  });

  it('no-ops when no sink is ready', () => {
    recorderMocks.db.isReady = false;

    recordCompactionAuditSnapshot({ result: compactionResult() });

    expect(recorderMocks.db.insertCompactionSnapshot).not.toHaveBeenCalled();
    expect(recorderMocks.logger.warn).not.toHaveBeenCalled();
  });

  it('does not throw when the sink rejects the audit write', () => {
    recorderMocks.db.insertCompactionSnapshot.mockImplementation(() => {
      throw new Error('sqlite busy');
    });

    expect(() => recordCompactionAuditSnapshot({ result: compactionResult() })).not.toThrow();
    expect(recorderMocks.logger.warn).toHaveBeenCalledOnce();
  });
});
