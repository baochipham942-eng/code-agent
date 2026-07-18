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
    'Unresolved error: AssertionError: expected true',
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

vi.mock('../../../src/host/tools/fileReadTracker', () => ({
  fileReadTracker: {
    getRecentFiles: vi.fn(() => []),
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
      anchorMessageId: 'm4',
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

  it('preserves the latest user instruction even when more than ten messages follow it', () => {
    const currentUserMessage = message('current-user', 'user', 'Implement the requested boundary fix exactly.');
    const messages: Message[] = [
      message('history-1', 'system', 'historical system context'),
      message('history-2', 'assistant', 'historical assistant context'),
      currentUserMessage,
      ...Array.from({ length: 11 }, (_, index) =>
        message(`tail-${index + 1}`, index % 2 === 0 ? 'assistant' : 'tool', `tail message ${index + 1}`),
      ),
    ];

    const plan = createCompactionPlan({
      sessionId: 'session-latest-user',
      source: 'auto_threshold',
      messages,
    });

    expect(plan).not.toBeNull();
    expect(plan?.compactedMessages.map((item) => item.id)).toEqual(['history-1', 'history-2']);
    expect(plan?.preservedMessages.map((item) => item.id)).toContain(currentUserMessage.id);
    expect(plan?.compactedMessages.map((item) => item.id)).not.toContain(currentUserMessage.id);
  });

  it('moves a tool call and its result to the preserved side when the default boundary splits them', () => {
    const messages: Message[] = Array.from({ length: 14 }, (_, index) =>
      message(`m${index + 1}`, 'assistant', `message ${index + 1}`),
    );
    messages[3] = {
      ...message('m4', 'assistant', 'calling tool'),
      toolCalls: [{ id: 'call-at-boundary', name: 'read_file', arguments: { path: '/tmp/example' } }],
    };
    messages[4] = {
      ...message('m5', 'tool', 'tool result'),
      toolResults: [{ toolCallId: 'call-at-boundary', success: true, output: 'ok' }],
    };

    const plan = createCompactionPlan({
      sessionId: 'session-tool-pair',
      source: 'auto_threshold',
      messages,
    });

    expect(plan).not.toBeNull();
    expect(plan?.compactedMessages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
    expect(plan?.preservedMessages.slice(0, 2).map((item) => item.id)).toEqual(['m4', 'm5']);
  });

  it('keeps an unclosed tool call in the preserved messages', () => {
    const messages: Message[] = Array.from({ length: 14 }, (_, index) =>
      message(`m${index + 1}`, 'assistant', `message ${index + 1}`),
    );
    messages[3] = {
      ...message('m4', 'assistant', 'calling a tool that has not returned'),
      toolCalls: [{ id: 'dangling-call', name: 'read_file', arguments: { path: '/tmp/example' } }],
    };

    const plan = createCompactionPlan({
      sessionId: 'session-dangling-tool-call',
      source: 'auto_threshold',
      messages,
    });

    expect(plan).not.toBeNull();
    expect(plan?.compactedMessages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
    expect(plan?.preservedMessages[0]?.id).toBe('m4');
  });

  it('adds a focus block after the survivor manifest and before the compacted transcript', async () => {
    const messages = [
      message('m1', 'user', 'Discuss renderer /compact command behavior. '.repeat(80)),
      message('m2', 'assistant', 'Need to route focus text through compaction. '.repeat(80)),
      message('m3', 'tool', 'ok'),
      message('m4', 'assistant', 'recent answer'),
    ];

    await compactMessagesWithSummary({
      sessionId: 'session-focus',
      source: 'manual_current',
      messages,
      anchorMessageId: 'm4',
      preserveRecentCount: 1,
      focusText: '保留 /compact 命令修复大纲',
    });

    const prompt = compactionServiceMocks.summarizeWithMetadata.mock.calls[0][0] as string;
    const manifestIndex = prompt.indexOf('Survivor Manifest:');
    const focusIndex = prompt.indexOf('User Focus For This Compaction:');
    const transcriptIndex = prompt.indexOf('Compacted Transcript:');

    expect(focusIndex).toBeGreaterThan(manifestIndex);
    expect(focusIndex).toBeLessThan(transcriptIndex);
    expect(prompt).toContain('保留 /compact 命令修复大纲');
    expect(prompt).toContain('This is a prioritization signal only.');
    expect(prompt).toContain('Do not ignore the Hard rules or Survivor Manifest above.');
  });

  it('keeps the no-focus prompt byte-for-byte identical for empty focus values', async () => {
    const messages = [
      message('m1', 'user', 'Read /Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts '.repeat(80)),
      message('m2', 'assistant', 'TODO: wire service into IPC. '.repeat(80)),
      message('m3', 'tool', 'AssertionError: expected true '.repeat(80)),
      message('m4', 'assistant', 'recent answer'),
    ];

    await compactMessagesWithSummary({
      sessionId: 'session-no-focus',
      source: 'manual_current',
      messages,
      anchorMessageId: 'm4',
      preserveRecentCount: 1,
    });
    const noFocusPrompt = compactionServiceMocks.summarizeWithMetadata.mock.calls[0][0] as string;

    compactionServiceMocks.summarizeWithMetadata.mockClear();
    await compactMessagesWithSummary({
      sessionId: 'session-no-focus',
      source: 'manual_current',
      messages,
      anchorMessageId: 'm4',
      preserveRecentCount: 1,
      focusText: '   ',
    });

    expect(compactionServiceMocks.summarizeWithMetadata.mock.calls[0][0]).toBe(noFocusPrompt);
    // 只对比"不传 vs 传空白"会跟着实现一起变异——必须钉死旧 prompt 里没有 focus 块
    expect(noFocusPrompt).not.toContain('User Focus For This Compaction:');
  });

  it('keeps the focus block on repair prompts', async () => {
    compactionServiceMocks.summarizeWithMetadata
      .mockResolvedValueOnce({
        summary: 'Tiny summary without required survivors.',
        metadata: compactionServiceMocks.summaryModel,
      })
      .mockResolvedValueOnce({
        summary: compactionServiceMocks.summary,
        metadata: compactionServiceMocks.summaryModel,
      });
    const messages = [
      message('m1', 'user', 'Read /Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts '.repeat(80)),
      message('m2', 'assistant', 'recent answer'),
      message('m3', 'assistant', 'recent tail'),
    ];

    await compactMessagesWithSummary({
      sessionId: 'session-focus-repair',
      source: 'manual_current',
      messages,
      anchorMessageId: 'm3',
      preserveRecentCount: 1,
      focusText: '只关注死掉的 /compact 命令',
    });

    expect(compactionServiceMocks.summarizeWithMetadata).toHaveBeenCalledTimes(2);
    const repairPrompt = compactionServiceMocks.summarizeWithMetadata.mock.calls[1][0] as string;
    expect(repairPrompt).toContain('User Focus For This Compaction:');
    expect(repairPrompt).toContain('只关注死掉的 /compact 命令');
    expect(repairPrompt).toContain('Repair instruction:');
  });

  it('shares file survivor mode metadata and warns the summary model about stale file records', async () => {
    const survivorSummary = compactionServiceMocks.summary
      .replaceAll(
        '/Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts',
        '/Users/linchen/Downloads/ai/code-agent/src/host/context/survivorManifest.ts',
      )
      .replace('TODO: wire service into IPC.', 'TODO: keep survivor details.');
    compactionServiceMocks.summarizeWithMetadata.mockResolvedValue({
      summary: survivorSummary,
      metadata: compactionServiceMocks.summaryModel,
    });
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
      anchorMessageId: 'm4',
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
      anchorMessageId: 'm4',
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
        'assistant',
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
      anchorMessageId: 'm4',
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
      anchorMessageId: 'm4',
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
      anchorMessageId: 'm4',
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

  it('fails closed when the repaired summary still misses required survivors', async () => {
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
      anchorMessageId: 'm3',
      preserveRecentCount: 1,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_summary_projection');
    expect(result.validation?.ok).toBe(false);
    expect(result.block).toBeUndefined();
    expect(result.summaryMessage).toBeUndefined();
    expect(result.newMessages).toBeUndefined();
    expect(result.warnings).toContain('Summary admission failed after repair; compaction was rejected.');
    expect(compactionServiceMocks.summarizeWithMetadata).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'provider-truncated',
      summary: 'A compact handoff summary.',
      metadata: { ...compactionServiceMocks.summaryModel, truncated: true },
      field: 'truncated' as const,
    },
    {
      name: 'whitespace-only',
      summary: ' \n\t ',
      metadata: compactionServiceMocks.summaryModel,
      field: 'emptyOrWhitespace' as const,
    },
    {
      name: 'over-budget',
      summary: 'oversized summary '.repeat(1200),
      metadata: compactionServiceMocks.summaryModel,
      field: 'overBudget' as const,
    },
  ])('rejects a $name summary before it can enter a CompactionBlock', async ({ summary, metadata, field }) => {
    compactionServiceMocks.summarizeWithMetadata.mockResolvedValue({ summary, metadata });
    const messages = [
      message('m1', 'assistant', 'Historical analysis. '.repeat(120)),
      message('m2', 'assistant', 'Historical implementation notes. '.repeat(120)),
      message('m3', 'user', 'Keep this current request.'),
      message('m4', 'assistant', 'recent answer'),
    ];
    const originalMessages = messages.map(item => ({ ...item }));

    const result = await compactMessagesWithSummary({
      sessionId: `session-invalid-${field}`,
      source: 'manual_current',
      messages,
      preserveRecentCount: 2,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_summary_projection');
    expect(result.validation).toMatchObject({ ok: false, [field]: true });
    expect(result.block).toBeUndefined();
    expect(result.summaryMessage).toBeUndefined();
    expect(result.newMessages).toBeUndefined();
    expect(result.plan.messages).toBe(messages);
    expect(result.plan.messages).toEqual(originalMessages);
    expect(compactionServiceMocks.summarizeWithMetadata).toHaveBeenCalledTimes(2);
  });
});
