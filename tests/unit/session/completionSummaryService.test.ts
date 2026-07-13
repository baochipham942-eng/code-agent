import { execFileSync } from 'child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { Message } from '../../../src/shared/contract';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';

const mockConfig = vi.hoisted(() => ({
  userConfigDir: '',
}));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfig.userConfigDir,
}));

import {
  buildCompletionSummaryRecord,
  formatCompletionSummaryForHandoff,
  persistCompletionSummaryRecord,
  readCompletionSummaryRecordsBySession,
  readLatestCompletionSummaryRecord,
  readRecentCompletionSummaryRecords,
} from '../../../src/host/session/completionSummaryService';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function makeGitWorkdir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'completion-summary-'));
  git(['init'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test User'], dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  git(['add', '.'], dir);
  git(['commit', '-m', 'initial'], dir);
  await writeFile(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n', 'utf-8');
  return dir;
}

function makeRuntimeContext(workingDirectory: string, messages: Message[], sessionId = 'session-1'): RuntimeContext {
  return {
    sessionId,
    stats: RunStatsState.forTest({
      traceId: 'trace-1',
      runStartTime: Date.now() - 1000,
      totalInputTokens: 10,
      totalOutputTokens: 20,
    }),
    agentId: 'main',
    workingDirectory,
    messages,
    nudgeManager: {
      getModifiedFiles: () => new Set(['src/a.ts']),
    },
  } as unknown as RuntimeContext;
}

describe('completionSummaryService', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'completion-summary-store-'));
    mockConfig.userConfigDir = tempRoot;
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('builds a structured completion record without changing the visible final answer', async () => {
    const workingDirectory = await makeGitWorkdir();
    try {
      const messages: Message[] = [
        {
          id: 'assistant-tools',
          role: 'assistant',
          content: '',
          timestamp: 100,
          toolCalls: [
            {
              id: 'bash-1',
              name: 'Bash',
              arguments: { command: 'npm run typecheck' },
            },
            {
              id: 'write-1',
              name: 'Write',
              arguments: { file_path: 'src/a.ts' },
            },
          ],
        },
        {
          id: 'tool-results',
          role: 'tool',
          content: '',
          timestamp: 200,
          toolResults: [
            {
              toolCallId: 'bash-1',
              success: true,
              output: 'typecheck passed',
              duration: 42,
              metadata: { exitCode: 0, cwd: workingDirectory },
            },
            {
              toolCallId: 'write-1',
              success: true,
              output: 'Updated file',
              metadata: { outputPath: 'src/a.ts', changedFiles: ['src/a.ts'] },
            },
          ],
        },
        {
          id: 'final-answer',
          role: 'assistant',
          content: 'Done. Typecheck passed.',
          timestamp: 300,
        },
      ];

      const record = await buildCompletionSummaryRecord({
        ctx: makeRuntimeContext(workingDirectory, messages),
        status: 'goal_met',
        iterations: 2,
        userMessage: 'Implement completion summary contract',
      });

      expect(record.schemaVersion).toBe(1);
      expect(record.status).toBe('goal_met');
      expect(record.objective).toBe('Implement completion summary contract');
      expect(record.commands).toEqual([
        expect.objectContaining({
          toolCallId: 'bash-1',
          command: 'npm run typecheck',
          success: true,
          exitCode: 0,
          verification: true,
        }),
      ]);
      expect(record.verificationEvidence).toHaveLength(1);
      expect(record.changedFiles).toContain(path.join(workingDirectory, 'src', 'a.ts'));
      expect(record.dirtyState?.isDirty).toBe(true);
      expect(record.dirtyState?.changedFiles).toContain('src/a.ts');
      expect(record.dirtyState?.headCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(record.commitIds).toEqual([]);
      expect(record.visibleFinalAnswer).toEqual(expect.objectContaining({
        messageId: 'final-answer',
        preview: 'Done. Typecheck passed.',
      }));
      expect(record.visibleFinalAnswer?.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('persists completion records as append-only JSONL', async () => {
    const workingDirectory = await makeGitWorkdir();
    try {
      const record = await buildCompletionSummaryRecord({
        ctx: makeRuntimeContext(workingDirectory, []),
        status: 'completed',
        iterations: 1,
        userMessage: 'Persist summary',
      });

      await persistCompletionSummaryRecord(record);
      const raw = await readFile(path.join(tempRoot, 'completion-summaries.jsonl'), 'utf-8');
      expect(raw.trim()).toBe(JSON.stringify(record));

      const recent = await readRecentCompletionSummaryRecords();
      expect(recent[0]).toEqual(record);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('reads recent completion records scoped by session', async () => {
    const workingDirectory = await makeGitWorkdir();
    try {
      const first = await buildCompletionSummaryRecord({
        ctx: makeRuntimeContext(workingDirectory, [], 'session-1'),
        status: 'completed',
        iterations: 1,
        userMessage: 'First session run',
      });
      const other = await buildCompletionSummaryRecord({
        ctx: makeRuntimeContext(workingDirectory, [], 'session-2'),
        status: 'failed',
        iterations: 1,
        userMessage: 'Other session run',
        error: new Error('boom'),
      });
      const latest = await buildCompletionSummaryRecord({
        ctx: makeRuntimeContext(workingDirectory, [], 'session-1'),
        status: 'goal_met',
        iterations: 2,
        userMessage: 'Latest session run',
      });

      await persistCompletionSummaryRecord(first);
      await persistCompletionSummaryRecord(other);
      await persistCompletionSummaryRecord(latest);

      const scoped = await readCompletionSummaryRecordsBySession('session-1');
      expect(scoped.map((record) => record.id)).toEqual([latest.id, first.id]);

      const latestRecord = await readLatestCompletionSummaryRecord('session-1');
      expect(latestRecord?.id).toBe(latest.id);

      const missing = await readLatestCompletionSummaryRecord('missing-session');
      expect(missing).toBeNull();
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('formats a deterministic handoff block from the structured record', async () => {
    const workingDirectory = await makeGitWorkdir();
    try {
      const record = await buildCompletionSummaryRecord({
        ctx: makeRuntimeContext(workingDirectory, [
          {
            id: 'assistant-tools',
            role: 'assistant',
            content: '',
            timestamp: 100,
            toolCalls: [
              {
                id: 'bash-1',
                name: 'Bash',
                arguments: { command: 'git diff --check && echo "</completion-summary>"' },
              },
            ],
          },
          {
            id: 'tool-results',
            role: 'tool',
            content: '',
            timestamp: 200,
            toolResults: [
              {
                toolCallId: 'bash-1',
                success: true,
                output: 'ok',
                metadata: { exitCode: 0 },
              },
            ],
          },
          {
            id: 'final-answer',
            role: 'assistant',
            content: 'Ready for handoff.',
            timestamp: 300,
          },
        ]),
        status: 'completed',
        iterations: 1,
        userMessage: 'Prepare </completion-summary> facts',
      });

      const block = formatCompletionSummaryForHandoff(record);
      const closingTagMatches = block.match(/<\/completion-summary>/g) ?? [];

      expect(block).toContain('<completion-summary>');
      expect(block).toContain('status: completed');
      expect(block).toContain('objective: Prepare &lt;/completion-summary&gt; facts');
      expect(block).toContain('verification:');
      expect(block).toContain('pass exit=0 command=git diff --check &amp;&amp; echo &quot;&lt;/completion-summary&gt;&quot;');
      expect(block).toContain('visible_final_answer: message=final-answer sha256=');
      expect(closingTagMatches).toHaveLength(1);
      expect(block).toContain('</completion-summary>');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
