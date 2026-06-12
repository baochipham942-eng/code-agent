import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { SessionTask } from '../../../src/shared/contract/planning';
import {
  runCheckpointWriterAgent,
  type CheckpointWriterJob,
} from '../../../src/main/agent/checkpointWriterAgent';
import {
  createCheckpointTemplate,
  replaceSectionBody,
  resolveCheckpointStorePaths,
} from '../../../src/main/context/checkpoint';

function message(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 } as Message;
}

function task(id: string, subject: string, status: SessionTask['status']): SessionTask {
  return {
    id,
    subject,
    status,
    priority: 'normal',
    blocks: [],
    blockedBy: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  } as SessionTask;
}

const TASKS = [
  task('1', 'implement checkpoint writer', 'completed'),
  task('1.1', 'write writer tests', 'in_progress'),
];

function validLlmCheckpoint(): string {
  let doc = createCheckpointTemplate();
  doc = replaceSectionBody(doc, 1, '> "把 checkpoint writer 改成真子代理"');
  doc = replaceSectionBody(doc, 2, 'Run the live evidence harness next.');
  doc = replaceSectionBody(doc, 3, 'Preserve exact backtick: `--seed 42`');
  doc = replaceSectionBody(doc, 4, ['✅ 1 implement checkpoint writer', '  🔄 1.1 write writer tests'].join('\n'));
  doc = replaceSectionBody(doc, 5, 'Was wiring the LLM writer runner.');
  doc = replaceSectionBody(doc, 6, '- src/main/agent/checkpointWriterAgent.ts - runner under rework');
  doc = replaceSectionBody(doc, 7, 'Vitest fake timers conflict with waitForIdle loops.');
  doc = replaceSectionBody(doc, 8, 'EXDEV rename failure fixed by copy+unlink fallback.');
  doc = replaceSectionBody(doc, 9, '- branch: main\n- reason: test');
  doc = replaceSectionBody(doc, 10, 'Decided runner validates before write instead of post-hoc.');
  doc = replaceSectionBody(doc, 11, 'Open question: should notes.md be reset per cycle?');
  return doc;
}

function wrap(checkpoint: string, memory?: string): string {
  const memoryBlock = memory ? `\n<memory>\n${memory}\n</memory>` : '';
  return `<checkpoint>\n${checkpoint}\n</checkpoint>${memoryBlock}`;
}

describe('runCheckpointWriterAgent LLM subagent (audit C-H1/C-H2)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'ckpt-writer-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function job(overrides: Partial<CheckpointWriterJob> = {}): CheckpointWriterJob {
    return {
      sessionId: 'session-llm-writer',
      workingDirectory: '/tmp/project',
      messages: [
        message('m1', 'user', '把 checkpoint writer 改成真子代理，保留 `--seed 42` 配置'),
        message('m2', 'assistant', 'Working on the writer rework now.'),
      ],
      reason: 'manual',
      rootDir,
      now: 1_000,
      ...overrides,
    };
  }

  it('builds the writer prompt from real session sources and writes LLM-produced content', async () => {
    const prompts: string[] = [];
    const result = await runCheckpointWriterAgent(job(), {
      llm: async (prompt) => {
        prompts.push(prompt);
        return wrap(validLlmCheckpoint());
      },
      listSessionTasks: () => TASKS,
    });

    expect(result.success).toBe(true);
    const prompt = prompts[0];
    // taskStore 真实数据进 prompt（C-H2）
    expect(prompt).toContain('1.1');
    expect(prompt).toContain('write writer tests');
    expect(prompt).toContain('in_progress');
    // 会话内容进 prompt
    expect(prompt).toContain('把 checkpoint writer 改成真子代理');
    // exact-form literal 以"必须逐字保留"清单注入
    expect(prompt).toContain('`--seed 42`');
    // 当前 checkpoint 注入（首次为模板）
    expect(prompt).toContain('## §1 Active intent');

    // 文件内容是 LLM 产出，不是本地模板硬编码（C-H1）
    const written = await readFile(result.checkpointPath, 'utf-8');
    expect(written).toContain('Vitest fake timers conflict');
    expect(written).toContain('Decided runner validates before write');
    expect(written).toContain('Open question: should notes.md be reset per cycle?');
    expect(written).toContain('🔄 1.1 write writer tests');
  });

  it('repairs paraphrased or omitted instruction lines instead of rejecting (live-run hardening)', async () => {
    // LLM 常见劣化：§1 instruction 行被改写、§5 instruction 行被整行删掉
    const degraded = validLlmCheckpoint()
      .replace(
        '_Verbatim current user intent. Must include at least one block quote with exact user words._',
        '_The user intent, quoted verbatim below._',
      )
      .replace('_What was being done immediately before this checkpoint._\n', '');
    const result = await runCheckpointWriterAgent(job(), {
      llm: async () => wrap(degraded),
      listSessionTasks: () => TASKS,
    });

    expect(result.success).toBe(true);
    const written = await readFile(result.checkpointPath, 'utf-8');
    // 结构归代码：落盘文件恢复规范 instruction 行
    expect(written).toContain('_Verbatim current user intent. Must include at least one block quote with exact user words._');
    expect(written).toContain('_What was being done immediately before this checkpoint._');
    // 内容归 LLM：body 不丢
    expect(written).toContain('Was wiring the LLM writer runner.');
    expect(written).not.toContain('_The user intent, quoted verbatim below._');
  });

  it('fails closed on invalid LLM output and preserves the previous checkpoint', async () => {
    const paths = resolveCheckpointStorePaths({
      sessionId: 'session-llm-writer',
      workingDirectory: '/tmp/project',
      rootDir,
    });
    const result = await runCheckpointWriterAgent(job(), {
      llm: async () => wrap('# not a checkpoint at all'),
      listSessionTasks: () => TASKS,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    // 旧文件（模板）原样保留，没有被劣质输出污染
    const preserved = await readFile(paths.checkpointPath, 'utf-8');
    expect(preserved).toContain('## §11 Open notes');
    expect(preserved).not.toContain('not a checkpoint at all');
  });

  it('retries once with validation feedback before giving up', async () => {
    const prompts: string[] = [];
    let calls = 0;
    const result = await runCheckpointWriterAgent(job(), {
      llm: async (prompt) => {
        prompts.push(prompt);
        calls += 1;
        if (calls === 1) {
          // 第一次缺 §1 verbatim quote 且 §4 缺 task id
          return wrap(replaceSectionBody(createCheckpointTemplate(), 5, 'partial work'));
        }
        return wrap(validLlmCheckpoint());
      },
      listSessionTasks: () => TASKS,
    });

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    // 第二次 prompt 带上验证违规反馈
    expect(prompts[1]).toContain('VALIDATION FAILURES');
  });

  it('writes the memory file when the LLM returns a memory block', async () => {
    const memory = [
      '# Project Memory',
      '',
      '## Project context',
      'Code agent desktop app.',
      '',
      '## Rules',
      '- keep `--seed 42`',
      '',
      '## Architecture decisions',
      'Writer validates before write.',
      '',
      '## Discovered durable knowledge',
      'EXDEV needs copy+unlink fallback.',
      '',
    ].join('\n');
    const result = await runCheckpointWriterAgent(job(), {
      llm: async () => wrap(validLlmCheckpoint(), memory),
      listSessionTasks: () => TASKS,
    });

    expect(result.success).toBe(true);
    expect(await readFile(result.memoryPath, 'utf-8')).toContain('EXDEV needs copy+unlink fallback.');
  });

  it('reports failure when the LLM call itself throws', async () => {
    const result = await runCheckpointWriterAgent(job(), {
      llm: async () => {
        throw new Error('provider unavailable');
      },
      listSessionTasks: () => TASKS,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('provider unavailable');
  });
});
