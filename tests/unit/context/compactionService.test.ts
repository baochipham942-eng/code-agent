import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';

const compactionServiceMocks = vi.hoisted(() => ({
  summary: [
    '# Context Handoff',
    '',
    '## Current State',
    'Changed /Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts.',
    '',
    '## Files And Changes',
    '/Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts needs re-read before editing.',
    '',
    '## Commands And Evidence',
    'npm test failed with AssertionError.',
    '',
    '## Errors And Resolutions',
    'AssertionError: expected true',
    '',
    '## User Preferences And Constraints',
    'Keep scope small.',
    '',
    '## Open Work',
    'TODO: wire service into IPC.',
    '',
    '## Continue From Here',
    'Continue integration.',
    '',
    '## Needs Re-read',
    '/Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts',
  ].join('\n'),
  summaryModel: {
    provider: 'moonshot',
    model: 'kimi-k2.5',
    useMainModel: false,
  },
  recordAudit: vi.fn(),
  summarizeWithMetadata: vi.fn(),
}));

vi.mock('../../../src/host/context/compactModel', () => ({
  compactModelSummarize: vi.fn(async () => compactionServiceMocks.summary),
  compactModelSummarizeWithMetadata: compactionServiceMocks.summarizeWithMetadata,
}));

vi.mock('../../../src/host/tools/dataFingerprint', () => ({
  dataFingerprintStore: {
    toSummary: vi.fn(() => 'Data fingerprint: sheet columns are stable.'),
  },
}));

vi.mock('../../../src/host/context/compactionAuditRecorder', () => ({
  recordCompactionAuditSnapshot: compactionServiceMocks.recordAudit,
}));

import {
  compactMessagesWithSummary,
  createCompactionPlan,
} from '../../../src/host/context/compactionService';

function message(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: Number(id.replace(/\D/g, '') || 1) };
}

describe('compactionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    compactionServiceMocks.recordAudit.mockReset();
    compactionServiceMocks.summarizeWithMetadata.mockReset();
    compactionServiceMocks.summarizeWithMetadata.mockResolvedValue({
      summary: compactionServiceMocks.summary,
      metadata: compactionServiceMocks.summaryModel,
    });
  });

  it('creates a plan with compacted and preserved messages plus survivor manifest', () => {
    const messages = [
      message('m1', 'user', 'Read /Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts'),
      message('m2', 'assistant', 'TODO: wire service into IPC.'),
      message('m3', 'tool', 'AssertionError: expected true'),
      message('m4', 'assistant', 'recent answer'),
    ];

    const plan = createCompactionPlan({
      sessionId: 'session-1',
      source: 'manual_current',
      messages,
      preserveRecentCount: 1,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
    });

    expect(plan).not.toBeNull();
    expect(plan?.compactedMessages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
    expect(plan?.preservedMessages.map((item) => item.id)).toEqual(['m4']);
    expect(plan?.manifest.filePaths).toContain('/Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts');
    expect(plan?.manifest.todos.some((item) => item.text.includes('TODO'))).toBe(true);
    expect(plan?.manifest.errors.some((item) => item.text.includes('AssertionError'))).toBe(true);
  });

  it('shares file survivor mode metadata and warns the summary model about stale file records', async () => {
    const messages: Message[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Read /Users/linchen/Downloads/ai/code-agent/src/host/context/survivorManifest.ts '.repeat(80),
        timestamp: 1,
        toolCalls: [
          {
            id: 'call-1',
            name: 'read_file',
            arguments: {
              file_path: '/Users/linchen/Downloads/ai/code-agent/src/host/context/survivorManifest.ts',
            },
          },
        ],
        toolResults: [
          {
            toolCallId: 'call-1',
            success: true,
            output: '     1\texport const survivor = true;',
          },
        ],
      },
      message('m2', 'assistant', 'TODO: keep survivor details.'),
      message('m3', 'tool', 'ok'),
      message('m4', 'assistant', 'recent answer'),
    ];

    const result = await compactMessagesWithSummary({
      sessionId: 'session-files',
      source: 'manual_current',
      messages,
      preserveRecentCount: 1,
    });

    expect(result.success).toBe(true);
    expect(compactionServiceMocks.summarizeWithMetadata.mock.calls[0][0]).toContain(
      "Never claim to know a file's latest contents from a survivor record",
    );
    expect(compactionServiceMocks.summarizeWithMetadata.mock.calls[0][0]).toContain('survival=excerpt');
    expect(result.block?.survivorManifest?.files?.[0]).toMatchObject({
      path: '/Users/linchen/Downloads/ai/code-agent/src/host/context/survivorManifest.ts',
      needsReRead: true,
      survival: 'excerpt',
      excerpt: expect.stringContaining('export const survivor = true'),
    });
    expect(result.block?.survivorManifest?.files?.[0].reason).toContain('observed excerpt only');
  });

  it('compacts messages into one system handoff plus preserved tail', async () => {
    const messages = [
      message('m1', 'user', 'Read /Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts '.repeat(80)),
      message('m2', 'assistant', 'TODO: wire service into IPC. '.repeat(80)),
      message('m3', 'tool', 'AssertionError: expected true '.repeat(80)),
      message('m4', 'assistant', 'recent answer'),
    ];

    const result = await compactMessagesWithSummary({
      sessionId: 'session-1',
      source: 'manual_current',
      messages,
      preserveRecentCount: 1,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
    });

    expect(result.success).toBe(true);
    expect(result.newMessages?.[0].role).toBe('system');
    expect(result.newMessages?.slice(1).map((item) => item.id)).toEqual(['m4']);
    expect(result.newMessages?.[0].timestamp).toBeLessThan(result.newMessages?.[1].timestamp ?? 0);
    expect(result.block?.source).toBe('manual_current');
    expect(result.block?.provider).toBe('moonshot');
    expect(result.block?.model).toBe('kimi-k2.5');
    expect(result.summaryModel).toEqual({
      provider: 'moonshot',
      model: 'kimi-k2.5',
      useMainModel: false,
    });
    expect(result.block?.survivorManifest?.files?.[0].path).toBe('/Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts');
    expect(compactionServiceMocks.recordAudit).toHaveBeenCalledWith({
      result: expect.objectContaining({
        success: true,
        block: expect.objectContaining({ source: 'manual_current' }),
      }),
      usagePercent: undefined,
      createdAt: undefined,
    });
  });

  it('keeps the summary transcript bounded and omits raw tool output from the prompt body', () => {
    const secretToolOutput = 'SECRET_FILE_CONTENT '.repeat(240);
    const messages: Message[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'I will read /Users/linchen/Downloads/ai/code-agent/src/host/context/compactionService.ts',
        timestamp: 1,
        toolCalls: [
          {
            id: 'call-1',
            name: 'read_file',
            arguments: {
              file_path: '/Users/linchen/Downloads/ai/code-agent/src/host/context/compactionService.ts',
            },
          },
        ],
        toolResults: [
          {
            toolCallId: 'call-1',
            success: true,
            output: secretToolOutput,
          },
        ],
      },
      {
        id: 'm2',
        role: 'tool',
        content: secretToolOutput,
        timestamp: 2,
      },
      message('m3', 'assistant', 'recent answer'),
    ];

    const plan = createCompactionPlan({
      sessionId: 'session-bounded',
      source: 'manual_current',
      messages,
      preserveRecentCount: 1,
    });

    expect(plan).not.toBeNull();
    expect(plan?.contentToSummarize).not.toContain('SECRET_FILE_CONTENT');
    expect(plan?.contentToSummarize).toContain('[omitted ');
    expect(plan?.contentToSummarize).toContain('tool output omitted from compaction transcript');
    expect(plan?.manifest.files[0]).toMatchObject({
      path: '/Users/linchen/Downloads/ai/code-agent/src/host/context/compactionService.ts',
      needsReRead: true,
    });
  });

  it('caps oversized transcript input while preserving a marker and the recent compacted tail', () => {
    const messages: Message[] = Array.from({ length: 90 }, (_, index) =>
      message(
        `m${index + 1}`,
        index % 2 === 0 ? 'user' : 'assistant',
        `historical message ${index + 1} ${'long context '.repeat(260)}`,
      ),
    );

    messages.push(message('m91', 'assistant', 'preserved live tail'));

    const plan = createCompactionPlan({
      sessionId: 'session-budget',
      source: 'auto_threshold',
      messages,
      preserveRecentCount: 1,
    });

    expect(plan).not.toBeNull();
    expect(estimateTokens(plan?.contentToSummarize ?? '')).toBeLessThanOrEqual(12_000);
    expect(plan?.contentToSummarize).toContain('compaction-transcript-budget-marker');
    expect(plan?.contentToSummarize).toContain('omitted from the transcript because the summary input hit its token budget');
    expect(plan?.contentToSummarize).toContain('[assistant m90]');
  });

  it('includes archived tool result refs in the survivor manifest and summary prompt', async () => {
    const archivedToolResults = [
      {
        version: 1 as const,
        artifactId: 'tool_result:session-archive:Bash:call-1:abc123def456',
        filePath: '/Users/linchen/.code-agent/tmp/session-archive/tool-results/Bash-call-1.txt',
        toolName: 'Bash',
        sessionId: 'session-archive',
        sha256: 'abc123def456'.padEnd(64, '0'),
        bytes: 2048,
        createdAt: 1000,
        reason: 'bash-output-limit',
        toolCallId: 'call-1',
        sourceMessageId: 'msg-1',
      },
    ];
    const messages = [
      message('m1', 'user', 'Run a large command. '.repeat(80)),
      message('m2', 'assistant', 'The command output was archived. '.repeat(80)),
      message('m3', 'tool', 'truncated result '.repeat(80)),
      message('m4', 'assistant', 'recent answer'),
    ];

    const result = await compactMessagesWithSummary({
      sessionId: 'session-archive',
      source: 'manual_current',
      messages,
      preserveRecentCount: 1,
      archivedToolResults,
    });

    expect(result.success).toBe(true);
    expect(compactionServiceMocks.summarizeWithMetadata.mock.calls[0][0]).toContain('## Archived Tool Results');
    expect(compactionServiceMocks.summarizeWithMetadata.mock.calls[0][0]).toContain(
      'recover: read_tool_result_archive artifact_id=tool_result:session-archive:Bash:call-1:abc123def456',
    );
    expect(result.block?.survivorManifest?.archivedToolResults?.[0]).toMatchObject({
      label: 'tool_result:session-archive:Bash:call-1:abc123def456',
      detail: expect.stringContaining('recover=read_tool_result_archive artifact_id=tool_result:session-archive:Bash:call-1:abc123def456'),
      severity: 'info',
    });
  });

  it('runs PreCompact and PostCompact hooks around summary compaction', async () => {
    const hookManager = {
      triggerPreCompact: vi.fn().mockResolvedValue({
        preservedContext: 'Hook preserved deploy note.',
      }),
      triggerPostCompact: vi.fn().mockResolvedValue({}),
    };
    const messages = [
      message('m1', 'user', 'Read /Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts '.repeat(80)),
      message('m2', 'assistant', 'TODO: wire service into IPC. '.repeat(80)),
      message('m3', 'tool', 'AssertionError: expected true '.repeat(80)),
      message('m4', 'assistant', 'recent answer'),
    ];

    const result = await compactMessagesWithSummary({
      sessionId: 'session-hooks',
      source: 'auto_threshold',
      messages,
      preserveRecentCount: 1,
      hookManager,
    });

    expect(result.success).toBe(true);
    expect(hookManager.triggerPreCompact).toHaveBeenCalledWith(
      'session-hooks',
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool', content: expect.stringContaining('AssertionError') }),
      ]),
      expect.any(Number),
      expect.any(Number),
    );
    expect(compactionServiceMocks.summarizeWithMetadata.mock.calls[0][0]).toContain('Hook preserved deploy note.');
    expect(hookManager.triggerPostCompact).toHaveBeenCalledWith(
      expect.any(Number),
      'auto_threshold',
      'session-hooks',
    );
  });

  it('records fallback summary model metadata when compact summarization used the main model', async () => {
    compactionServiceMocks.summarizeWithMetadata.mockResolvedValue({
      summary: compactionServiceMocks.summary,
      metadata: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        useMainModel: true,
        fallbackReason: 'compact_context_length_exceeded',
      },
    });
    const messages = [
      message('m1', 'user', 'Read /Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts '.repeat(80)),
      message('m2', 'assistant', 'TODO: wire service into IPC. '.repeat(80)),
      message('m3', 'tool', 'AssertionError: expected true '.repeat(80)),
      message('m4', 'assistant', 'recent answer'),
    ];

    const result = await compactMessagesWithSummary({
      sessionId: 'session-1',
      source: 'manual_current',
      messages,
      preserveRecentCount: 1,
      modelConfig: { provider: 'moonshot', model: 'kimi-k2.5' },
    });

    expect(result.success).toBe(true);
    expect(result.block?.provider).toBe('xiaomi');
    expect(result.block?.model).toBe('mimo-v2.5-pro');
    expect(result.summaryModel).toEqual({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      useMainModel: true,
      fallbackReason: 'compact_context_length_exceeded',
    });
  });

  it('prepends the deterministic manifest when the model summary misses required survivors', async () => {
    compactionServiceMocks.summarizeWithMetadata.mockResolvedValue({
      summary: 'Tiny summary without required survivors.',
      metadata: compactionServiceMocks.summaryModel,
    });
    const messages = [
      message('m1', 'user', 'Read /Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts '.repeat(80)),
      message('m2', 'assistant', 'recent answer'),
      message('m3', 'assistant', 'recent tail'),
    ];

    const result = await compactMessagesWithSummary({
      sessionId: 'session-1',
      source: 'manual_current',
      messages,
      preserveRecentCount: 1,
    });

    expect(result.success).toBe(true);
    expect(result.summary).toContain('# Deterministic Survivor Manifest');
    expect(result.summary).toContain('/Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts');
    expect(result.warnings).toContain('Summary missed survivor manifest items; deterministic manifest was prepended.');
    expect(compactionServiceMocks.summarizeWithMetadata).toHaveBeenCalledTimes(2);
  });
});
