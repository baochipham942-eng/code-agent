// ============================================================================
// 默认助手长期事实写回测试
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const quickModelMocks = vi.hoisted(() => ({
  quickTask: vi.fn<(
    prompt: string,
    maxTokens?: number,
  ) => Promise<{ success: boolean; content?: string; error?: string }>>(),
}));

vi.mock('../../../../src/host/config/configPaths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/config/configPaths')>();
  return {
    ...actual,
    getUserConfigDir: () => mockConfigDir.dir,
  };
});

vi.mock('../../../../src/host/model/quickModel', () => ({
  quickTask: quickModelMocks.quickTask,
}));

vi.mock('../../../../src/host/services/infra/timeoutController', () => ({
  withTimeout: <T>(promise: Promise<T>) => promise,
}));

vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

import { RunFinalizer } from '../../../../src/host/agent/runtime/runFinalizer';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import {
  judgeConversation,
  type DurableFact,
} from '../../../../src/host/lightMemory/conversationJudge';
import { writeDurableFacts } from '../../../../src/host/lightMemory/durableFactWriter';
import { SESSION_JUDGE } from '../../../../src/shared/constants';

interface SummaryRunner {
  extractAndSaveConversationSummary(): Promise<void>;
}

function makeFact(index: number, overrides: Partial<DurableFact> = {}): DurableFact {
  return {
    filename: `fact-${index}.md`,
    name: `事实 ${index}`,
    description: `第 ${index} 条长期事实`,
    type: 'user',
    content: `长期内容 ${index}`,
    ...overrides,
  };
}

function llmResult(input: {
  worth?: boolean;
  durableFacts?: unknown[];
}): { success: true; content: string } {
  return {
    success: true,
    content: JSON.stringify({
      worth: input.worth ?? true,
      isMeeting: false,
      title: '长期事实测试',
      worthKnowledge: ['用户提供了稳定信息'],
      durableFacts: input.durableFacts ?? [],
    }),
  };
}

async function listFactFiles(memoryDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(memoryDir))
      .filter((filename) => filename.endsWith('.md'))
      .filter((filename) => filename !== 'INDEX.md' && filename !== 'recent-conversations.md')
      .sort();
  } catch {
    return [];
  }
}

async function waitForFactFiles(memoryDir: string, expected: string[]): Promise<void> {
  await vi.waitFor(async () => {
    expect(await listFactFiles(memoryDir)).toEqual(expected);
  });
}

async function runSummaryExtraction(): Promise<void> {
  const finalizer = new RunFinalizer({
    messages: [
      { role: 'user', content: '我在上海，长期住这里。' },
      { role: 'assistant', content: '已了解。' },
    ],
  } as unknown as RuntimeContext);

  await (finalizer as unknown as SummaryRunner).extractAndSaveConversationSummary();
}

describe('默认助手长期事实写回', () => {
  let tempDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    quickModelMocks.quickTask.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-facts-'));
    mockConfigDir.dir = tempDir;
    memoryDir = path.join(tempDir, 'memory');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('判断器返回两条合格事实时写入两个文件并维护索引', async () => {
    quickModelMocks.quickTask.mockResolvedValue(llmResult({
      durableFacts: [makeFact(1), makeFact(2)],
    }));

    await runSummaryExtraction();

    await waitForFactFiles(memoryDir, ['fact-1.md', 'fact-2.md']);
    expect(quickModelMocks.quickTask).toHaveBeenCalledTimes(1);
    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(index.match(/\[fact-1\.md\]/g)).toHaveLength(1);
    expect(index.match(/\[fact-2\.md\]/g)).toHaveLength(1);
  });

  it('同名再次写入时更新内容且不增加文件或索引行', async () => {
    await writeDurableFacts([makeFact(1, { content: '旧内容' })]);
    await writeDurableFacts([makeFact(1, { content: '更新后的内容' })]);

    expect(await listFactFiles(memoryDir)).toEqual(['fact-1.md']);
    const content = await fs.readFile(path.join(memoryDir, 'fact-1.md'), 'utf-8');
    expect(content).toContain('更新后的内容');
    expect(content).not.toContain('旧内容');
    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(index.match(/\[fact-1\.md\]/g)).toHaveLength(1);
  });

  it('worth 为 false 时不写入长期事实', async () => {
    quickModelMocks.quickTask.mockResolvedValue(llmResult({
      worth: false,
      durableFacts: [makeFact(1)],
    }));

    await runSummaryExtraction();

    expect(await listFactFiles(memoryDir)).toEqual([]);
  });

  it('quick model 降级为 heuristic 时不写入长期事实', async () => {
    quickModelMocks.quickTask.mockResolvedValue({ success: false, error: '模型不可用' });

    await runSummaryExtraction();

    expect(await listFactFiles(memoryDir)).toEqual([]);
  });

  it('逐条拒绝非法文件名和类型，同批合法条目照常写入', async () => {
    quickModelMocks.quickTask.mockResolvedValue(llmResult({
      durableFacts: [
        makeFact(1),
        makeFact(2, { filename: '../path-traversal.md' }),
        makeFact(3, { filename: 'missing-extension' }),
        { ...makeFact(4), type: 'skill' },
        makeFact(6, { filename: 'windows\\path.md' }),
        makeFact(5),
      ],
    }));

    const judgment = await judgeConversation({ userMessages: ['请记住我的稳定偏好。'] });
    expect(judgment.durableFacts.map((fact) => fact.filename)).toEqual(['fact-1.md', 'fact-5.md']);
    await writeDurableFacts(judgment.durableFacts);

    expect(await listFactFiles(memoryDir)).toEqual(['fact-1.md', 'fact-5.md']);
  });

  it('模型返回五条事实时只保留并写入前三条', async () => {
    quickModelMocks.quickTask.mockResolvedValue(llmResult({
      durableFacts: Array.from({ length: 5 }, (_, index) => makeFact(index + 1, {
        content: index === 0
          ? '长'.repeat(SESSION_JUDGE.MAX_DURABLE_FACT_CHARS + 100)
          : `长期内容 ${index + 1}`,
      })),
    }));

    const judgment = await judgeConversation({ userMessages: ['这里有多条长期信息。'] });
    expect(judgment.durableFacts).toHaveLength(SESSION_JUDGE.MAX_DURABLE_FACTS);
    expect(judgment.durableFacts[0].content).toHaveLength(SESSION_JUDGE.MAX_DURABLE_FACT_CHARS);
    await writeDurableFacts(judgment.durableFacts);

    expect(await listFactFiles(memoryDir)).toEqual(['fact-1.md', 'fact-2.md', 'fact-3.md']);
  });
});
