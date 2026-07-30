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

  it('groups changed files and Git HEAD state for every Project Source', async () => {
    const primary = await makeGitWorkdir();
    const additional = await makeGitWorkdir();
    try {
      const ctx = makeRuntimeContext(primary, []);
      (ctx as { workspaceScope?: unknown }).workspaceScope = {
        projectId: 'project-1',
        primaryRoot: primary,
        roots: [
          { sourceId: 'primary', path: primary, role: 'primary', access: 'read_write' },
          { sourceId: 'additional', path: additional, role: 'additional', access: 'read_write' },
        ],
        version: 'scope-v1',
      };
      (ctx as { nudgeManager: unknown }).nudgeManager = {
        getModifiedFiles: () => new Set([
          path.join(primary, 'src', 'a.ts'),
          path.join(additional, 'src', 'a.ts'),
        ]),
      };

      const record = await buildCompletionSummaryRecord({
        ctx,
        status: 'completed',
        iterations: 1,
        userMessage: 'Multi repo delivery',
      });

      expect(record.workspaceScopeVersion).toBe('scope-v1');
      expect(record.dirtyStates).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceId: 'primary', isDirty: true, headCommit: expect.stringMatching(/^[a-f0-9]{40}$/) }),
        expect.objectContaining({ sourceId: 'additional', isDirty: true, headCommit: expect.stringMatching(/^[a-f0-9]{40}$/) }),
      ]));
      expect(record.changedFilesBySource).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceId: 'primary', files: [path.join(primary, 'src', 'a.ts')] }),
        expect.objectContaining({ sourceId: 'additional', files: [path.join(additional, 'src', 'a.ts')] }),
      ]));
    } finally {
      await Promise.all([
        rm(primary, { recursive: true, force: true }),
        rm(additional, { recursive: true, force: true }),
      ]);
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

// ============================================================================
// R7 账本污染回归门（2026-07-30 真机 session_1785393342389_a3480b45）
//
// 现场：用户在通话里说「帮我创建一个 txt 文件」，模型 Write /Users/linchen/a.txt，
// 被写前读门拒绝（success=false, NOT_READ_FOR_OVERWRITE），改用 Read 看了一眼，
// 然后如实答「a.txt 早就在那儿了，内容是 123，我没动它」。
// 而账本记下 changedFiles=["/Users/linchen/a.txt"]、artifactRefs 同一路径——
// 语音完成语义证据门读这份账，判出「已完成」。**证据门被自己的账本骗了。**
//
// 账本是证据门/口播/通知三条链的共同上游，它一旦把「想写」记成「写了」，
// 下游做得再严也没用。所以门钉在账本生产侧，且钉的是 success 语义本身。
// 两条工具结果的形状逐字段抄自真机 DB（messages.tool_results）。
// ============================================================================
describe('completionSummaryService · 只有真落盘的变更才进账（R7）', () => {
  let tempRoot: string;
  let workingDirectory: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'completion-summary-r7-'));
    mockConfig.userConfigDir = tempRoot;
    workingDirectory = await mkdtemp(path.join(tmpdir(), 'completion-summary-r7-wd-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(workingDirectory, { recursive: true, force: true });
  });

  /** 与主 harness 的区别：nudge 账为空，好让断言只盯工具结果这条路。 */
  function ctxWithMessages(messages: Message[]): RuntimeContext {
    const ctx = makeRuntimeContext(workingDirectory, messages, 'session-r7');
    (ctx as { nudgeManager: unknown }).nudgeManager = { getModifiedFiles: () => new Set<string>() };
    return ctx;
  }

  /** 真机那次被写前读门拒绝的 Write，逐字段照抄。 */
  function refusedWriteResult(filePath: string) {
    return {
      toolCallId: 'call_019fb1bdc18571209dd417e3',
      success: false,
      error: 'Existing file must be read before overwrite. Use Read first to bind the latest digest, then retry Write.',
      metadata: {
        code: 'NOT_READ_FOR_OVERWRITE',
        // ← 病灶：失败了照样带目标路径。这是「本来想写哪」，不是「写成了什么」。
        outputPath: filePath,
        writeIsolation: { kind: 'file', targetPath: filePath, lockKey: `file:${filePath}` },
      },
    };
  }

  it('Write 失败不入账：被写前读门拒绝的目标路径既不进 changedFiles 也不进 artifactRefs', async () => {
    const target = path.join(workingDirectory, 'a.txt');
    const messages: Message[] = [
      {
        id: 'assistant-write',
        role: 'assistant',
        content: '',
        timestamp: 100,
        toolCalls: [{ id: 'call_019fb1bdc18571209dd417e3', name: 'Write', arguments: { file_path: target, content: '' } }],
      },
      {
        id: '2dfaa1a8-d2bb-4dd2-8085-1ed00ae8851f',
        role: 'tool',
        content: '',
        timestamp: 200,
        toolResults: [refusedWriteResult(target)],
      },
      {
        id: 'final-answer',
        role: 'assistant',
        content: 'a.txt 已经存在了，里面是 123，我没有动它。',
        timestamp: 300,
      },
    ];

    const record = await buildCompletionSummaryRecord({
      ctx: ctxWithMessages(messages),
      status: 'completed',
      iterations: 4,
      userMessage: '帮我创建一个 txt 文件',
    });

    expect(record.changedFiles).toEqual([]);
    expect(record.artifactRefs).toEqual([]);
  });

  it('失败调用自称的 changedFiles 同样不认（工具都没跑成，那份清单是意图不是结果）', async () => {
    const messages: Message[] = [
      {
        id: 'tool-results',
        role: 'tool',
        content: '',
        timestamp: 200,
        toolResults: [{
          toolCallId: 'edit-1',
          success: false,
          error: 'patch did not apply',
          metadata: { changedFiles: ['src/never-touched.ts'], outputPath: 'src/never-touched.ts' },
        }],
      },
    ];

    const record = await buildCompletionSummaryRecord({
      ctx: ctxWithMessages(messages),
      status: 'completed',
      iterations: 1,
      userMessage: '改一下那个文件',
    });

    expect(record.changedFiles).toEqual([]);
  });

  it('Read 不入账：成功的读取带 artifact/evidenceRef，但一个字节都没改', async () => {
    const target = path.join(workingDirectory, 'a.txt');
    const messages: Message[] = [
      {
        id: 'assistant-read',
        role: 'assistant',
        content: '',
        timestamp: 100,
        toolCalls: [{ id: 'call_DACudkf1ceKOHRCsvT3JtNx7', name: 'Read', arguments: { file_path: target } }],
      },
      {
        id: 'dd46f4a0-fb2c-438d-83d8-e8c197435734',
        role: 'tool',
        content: '',
        timestamp: 200,
        // 真机 Read 结果形状：有 artifact、有 read 级 evidenceRef，但没有 outputPath。
        toolResults: [{
          toolCallId: 'call_DACudkf1ceKOHRCsvT3JtNx7',
          success: true,
          output: '     1\t123',
          metadata: {
            artifact: { artifactId: 'artifact_171973962f998451', kind: 'text', sourceTool: 'Read', path: target },
            evidenceRef: { id: 'evidence_58fd97b6', kind: 'read', ref: `${target}#L1-L1`, source: 'Read' },
            evidenceKind: 'file_read',
          },
        }],
      },
    ];

    const record = await buildCompletionSummaryRecord({
      ctx: ctxWithMessages(messages),
      status: 'completed',
      iterations: 2,
      userMessage: '看看 a.txt 里有什么',
    });

    expect(record.changedFiles).toEqual([]);
    expect(record.artifactRefs).toEqual([]);
  });

  it('成功的 Write 照常入账（别把门修成谁都进不来）', async () => {
    const target = path.join(workingDirectory, 'b.txt');
    const messages: Message[] = [
      {
        id: 'tool-results',
        role: 'tool',
        content: '',
        timestamp: 200,
        toolResults: [{
          toolCallId: 'write-ok',
          success: true,
          output: 'File created',
          metadata: { outputPath: target, changedFiles: [target] },
        }],
      },
    ];

    const record = await buildCompletionSummaryRecord({
      ctx: ctxWithMessages(messages),
      status: 'completed',
      iterations: 1,
      userMessage: '建个 b.txt',
    });

    expect(record.changedFiles).toEqual([target]);
    expect(record.artifactRefs).toEqual([{ kind: 'file', path: target, messageId: 'tool-results' }]);
  });
});
