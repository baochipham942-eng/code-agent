import { describe, expect, it } from 'vitest';

import {
  buildSurvivorManifest,
  buildContextSurvivorManifest,
  compactMessagesForSummary,
  extractAbsolutePaths,
  extractAbsoluteFilePaths,
  renderSurvivorManifestForPrompt,
  type SurvivorManifestMessage,
} from '../../../src/main/context/survivorManifest';

describe('survivorManifest', () => {
  it('extracts absolute file paths from message and tool output text', () => {
    const messages: SurvivorManifestMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        content:
          'Read /Users/linchen/Downloads/ai/code-agent/src/main/context/autoCompressor.ts and wrote /tmp/context-survivor.json.',
      },
      {
        id: 'm2',
        role: 'tool',
        content: 'output saved at /var/folders/test/result.log',
      },
    ];

    const manifest = buildContextSurvivorManifest(messages, { preserveRecentCount: 1 });

    expect(manifest.filePaths).toEqual([
      '/Users/linchen/Downloads/ai/code-agent/src/main/context/autoCompressor.ts',
      '/tmp/context-survivor.json',
      '/var/folders/test/result.log',
    ]);
    expect(extractAbsoluteFilePaths('see (/Users/linchen/a.ts), then /tmp/b.json.')).toEqual([
      '/Users/linchen/a.ts',
      '/tmp/b.json',
    ]);
    expect(extractAbsolutePaths('same alias /Users/linchen/c.ts')).toEqual(['/Users/linchen/c.ts']);
  });

  it('extracts error lines conservatively', () => {
    const manifest = buildContextSurvivorManifest(
      [
        {
          id: 'm1',
          role: 'tool',
          content: [
            'build output',
            'Traceback (most recent call last):',
            'Error: Cannot find module /Users/linchen/missing.ts',
            'all done',
          ].join('\n'),
          toolResults: [
            {
              toolCallId: 'call-1',
              success: false,
              error: 'Command failed with exit code 1',
              metadata: { output: '[stderr]: fatal: bad revision' },
            },
          ],
        },
      ],
      { preserveRecentCount: 1 }
    );

    expect(manifest.errors.map((item) => item.text)).toEqual([
      'Traceback (most recent call last):',
      'Error: Cannot find module /Users/linchen/missing.ts',
      '[stderr]: fatal: bad revision',
      'Command failed with exit code 1',
    ]);
  });

  it('summarizes shell commands with cwd, exit code, stdout, and stderr', () => {
    const manifest = buildContextSurvivorManifest(
      [
        {
          id: 'm1',
          role: 'assistant',
          content: 'running shell',
          toolCalls: [
            {
              id: 'call-1',
              name: 'bash',
              arguments: {
                command: 'npm test -- survivorManifest',
                cwd: '/Users/linchen/Downloads/ai/code-agent',
              },
            },
          ],
          toolResults: [
            {
              toolCallId: 'call-1',
              success: false,
              output: 'stdout line\n[stderr]: AssertionError: expected true',
              error: 'exit code 1',
              metadata: { exitCode: 1 },
            },
          ],
        },
      ],
      { preserveRecentCount: 1 }
    );

    expect(manifest.commands).toEqual([
      {
        messageId: 'm1',
        command: 'npm test -- survivorManifest',
        cwd: '/Users/linchen/Downloads/ai/code-agent',
        exitCode: 1,
        success: false,
        stdoutSummary: 'stdout line',
        stderrSummary: 'AssertionError: expected true\nexit code 1',
        errorSummary: 'exit code 1',
      },
    ]);
  });

  it('splits compacted and preserved ids by preserveRecentCount', () => {
    const manifest = buildSurvivorManifest({
      messages: [
        { id: 'm1', role: 'user', content: 'one' },
        { id: 'm2', role: 'assistant', content: 'two' },
        { id: 'm3', role: 'tool', content: 'three' },
        { id: 'm4', role: 'assistant', content: 'four' },
      ],
      sessionId: 'session-1',
      source: 'auto_threshold',
      anchorMessageId: 'm2',
      preserveRecentCount: 2,
    });

    expect(manifest.sessionId).toBe('session-1');
    expect(manifest.source).toBe('auto_threshold');
    expect(manifest.anchorMessageId).toBe('m2');
    expect(manifest.compactedMessageIds).toEqual(['m1', 'm2']);
    expect(manifest.preservedMessageIds).toEqual(['m3', 'm4']);
  });

  it('clips long command output with a clear per-item limit', () => {
    const longStdout = `start ${'0123456789 '.repeat(80)} end`;
    const manifest = buildContextSurvivorManifest(
      [
        {
          id: 'm1',
          role: 'assistant',
          content: 'running shell',
          toolCalls: [{ id: 'call-1', name: 'bash', arguments: { command: 'cat huge.log' } }],
          toolResults: [{ toolCallId: 'call-1', success: true, output: longStdout }],
        },
      ],
      { preserveRecentCount: 1, maxItemChars: 80 }
    );

    expect(manifest.commands[0].stdoutSummary).toContain('[truncated]');
    expect(manifest.commands[0].stdoutSummary!.length).toBeLessThanOrEqual(80);
  });

  it('extracts todos and artifact output paths', () => {
    const manifest = buildContextSurvivorManifest(
      [
        {
          id: 'm1',
          role: 'assistant',
          content: 'TODO: wire this into compaction service later\nSaved output to /tmp/report.md',
          toolResults: [
            {
              toolCallId: 'call-1',
              success: true,
              outputPath: '/tmp/report.md',
              metadata: { imagePath: '/tmp/chart.png' },
            },
          ],
        },
      ],
      { preserveRecentCount: 1 }
    );

    expect(manifest.todos).toEqual([
      { messageId: 'm1', text: 'TODO: wire this into compaction service later' },
    ]);
    expect(manifest.artifacts).toEqual([
      { messageId: 'm1', path: '/tmp/report.md', source: 'tool_result' },
      { messageId: 'm1', path: '/tmp/chart.png', source: 'metadata' },
    ]);
    expect(manifest.files).toEqual([
      expect.objectContaining({
        path: '/tmp/report.md',
        reason: 'absolute_path_reference',
        needsReRead: true,
        survival: 'path_only',
      }),
      expect.objectContaining({
        path: '/tmp/chart.png',
        reason: 'artifact_metadata',
        needsReRead: true,
        survival: 'path_only',
      }),
    ]);
    expect(manifest.openWork).toBe(manifest.todos);
  });

  it('adds safe file survivor excerpts and observed digests from read results', () => {
    const manifest = buildContextSurvivorManifest(
      [
        {
          id: 'm1',
          role: 'assistant',
          content: 'reading target file',
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_file',
              arguments: {
                file_path: '/Users/linchen/Downloads/ai/code-agent/src/main/context/survivorManifest.ts',
              },
            },
          ],
          toolResults: [
            {
              toolCallId: 'call-1',
              success: true,
              output: [
                '     1\tconst answer = 42;',
                '     2\texport const label = "safe";',
              ].join('\n'),
            },
          ],
        },
      ],
      {
        preserveRecentCount: 1,
        maxFileExcerptChars: 80,
        fileReadRecords: [
          {
            path: '/Users/linchen/Downloads/ai/code-agent/src/main/context/survivorManifest.ts',
            mtime: 100,
            readTime: 200,
            size: 2048,
          },
        ],
      },
    );

    expect(manifest.files[0]).toMatchObject({
      path: '/Users/linchen/Downloads/ai/code-agent/src/main/context/survivorManifest.ts',
      lastKnownReason: 'read_file_observed_text',
      needsReRead: true,
      survival: 'excerpt',
      metadata: {
        size: 2048,
        mtime: 100,
        readTime: 200,
        textLike: true,
      },
    });
    expect(manifest.files[0].digest).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(manifest.files[0].excerpt).toContain('const answer = 42');
    expect(manifest.files[0].excerpt).not.toContain('     1\t');
    expect(renderSurvivorManifestForPrompt(manifest)).toContain('survival=excerpt');
  });

  it('keeps large, sensitive, or binary survivor files as path-only records', () => {
    const manifest = buildContextSurvivorManifest(
      [
        {
          id: 'm1',
          role: 'assistant',
          content: [
            'Read /Users/linchen/Downloads/ai/code-agent/.env.local',
            'Read /Users/linchen/Downloads/report.pdf',
            'Read /Users/linchen/Downloads/ai/code-agent/src/main/huge.ts',
          ].join('\n'),
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_file',
              arguments: { file_path: '/Users/linchen/Downloads/ai/code-agent/.env.local' },
            },
            {
              id: 'call-2',
              name: 'read_file',
              arguments: { file_path: '/Users/linchen/Downloads/ai/code-agent/src/main/huge.ts' },
            },
          ],
          toolResults: [
            { toolCallId: 'call-1', success: true, output: '     1\tAPI_KEY=secret' },
            { toolCallId: 'call-2', success: true, output: '     1\texport const huge = true;' },
          ],
        },
      ],
      {
        preserveRecentCount: 1,
        fileReadRecords: [
          {
            path: '/Users/linchen/Downloads/ai/code-agent/src/main/huge.ts',
            size: 200_000,
          },
        ],
      },
    );

    expect(manifest.files).toHaveLength(3);
    expect(manifest.files[0]).toMatchObject(
      expect.objectContaining({
        path: '/Users/linchen/Downloads/ai/code-agent/.env.local',
        survival: 'path_only',
        needsReRead: true,
        metadata: expect.objectContaining({ sensitive: true }),
      }),
    );
    expect(manifest.files[0].digest).toBeUndefined();
    expect(manifest.files[0].excerpt).toBeUndefined();
    expect(manifest.files[1]).toMatchObject(
      expect.objectContaining({
        path: '/Users/linchen/Downloads/report.pdf',
        survival: 'path_only',
        needsReRead: true,
        metadata: expect.objectContaining({ textLike: false }),
      }),
    );
    expect(manifest.files[1].digest).toBeUndefined();
    expect(manifest.files[1].excerpt).toBeUndefined();
    expect(manifest.files[2]).toMatchObject(
      expect.objectContaining({
        path: '/Users/linchen/Downloads/ai/code-agent/src/main/huge.ts',
        survival: 'path_only',
        needsReRead: true,
        metadata: expect.objectContaining({ size: 200_000 }),
      }),
    );
    expect(manifest.files[2].digest).toBeUndefined();
    expect(manifest.files[2].excerpt).toBeUndefined();
  });

  it('compacts messages for summary and renders prompt text deterministically', () => {
    const messages: SurvivorManifestMessage[] = [
      { id: 'm1', role: 'user', content: 'x'.repeat(120) },
      { id: 'm2', role: 'assistant', content: 'TODO: keep this' },
    ];
    const compactMessages = compactMessagesForSummary(messages, { maxContentChars: 60 });
    const manifest = buildSurvivorManifest({
      messages,
      sessionId: 'session-1',
      source: 'manual_current',
      preserveRecentCount: 1,
      dataFingerprintText: 'verified rows=3',
    });

    expect(compactMessages).toEqual([
      { id: 'm1', role: 'user', content: expect.stringContaining('[truncated]') },
      { id: 'm2', role: 'assistant', content: 'TODO: keep this' },
    ]);
    expect(renderSurvivorManifestForPrompt(manifest)).toContain('# Context Survivor Manifest');
    expect(renderSurvivorManifestForPrompt(manifest)).toContain('sessionId=session-1 source=manual_current');
    expect(renderSurvivorManifestForPrompt(manifest)).toContain('## Data Fingerprint\nverified rows=3');
  });

  it('renders archived tool result refs with recovery instructions', () => {
    const manifest = buildContextSurvivorManifest(
      [{ id: 'm1', role: 'assistant', content: 'old tool result was archived' }],
      {
        preserveRecentCount: 1,
        archivedToolResults: [
          {
            version: 1,
            artifactId: 'tool_result:session-1:Bash:call-1:abc123def456',
            filePath: '/Users/linchen/.code-agent/tmp/session-1/tool-results/Bash-call-1.txt',
            toolName: 'Bash',
            sessionId: 'session-1',
            sha256: 'abc123def456'.padEnd(64, '0'),
            bytes: 1234,
            createdAt: 1000,
            reason: 'bash-output-limit',
            toolCallId: 'call-1',
            sourceMessageId: 'msg-1',
          },
        ],
      },
    );

    const rendered = renderSurvivorManifestForPrompt(manifest);

    expect(manifest.archivedToolResults).toEqual([
      expect.objectContaining({
        artifactId: 'tool_result:session-1:Bash:call-1:abc123def456',
        toolName: 'Bash',
        reason: 'bash-output-limit',
      }),
    ]);
    expect(rendered).toContain('## Archived Tool Results');
    expect(rendered).toContain('tool=Bash');
    expect(rendered).toContain('recover: read_tool_result_archive artifact_id=tool_result:session-1:Bash:call-1:abc123def456');
  });
});
