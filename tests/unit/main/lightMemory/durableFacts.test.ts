import { ControlState } from '../../../../src/host/agent/runtime/controlState';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
import { handleToolResultBookkeeping } from '../../../../src/host/agent/runtime/toolResultLifecycle';
import * as protocolTools from '../../../../src/host/tools/protocolToolRegistration';
import { webFetchUnifiedSchema } from '../../../../src/host/tools/modules/network/webFetchUnified.schema';
import { listMemoryInjectionTraces, clearMemoryInjectionTracesForTest } from '../../../../src/host/memory/memoryInjectionTrace';
// ============================================================================
// 默认助手长期事实写回测试
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const roleMocks = vi.hoisted(() => ({
  writeBack: vi.fn(async () => undefined),
  participation: vi.fn(),
}));
vi.mock('../../../../src/host/services/roleAssets/roleWriteBack', () => ({ runRoleWriteBack: roleMocks.writeBack }));
vi.mock('../../../../src/host/services/roleAssets/roleProactivity', () => ({ recordRoleParticipation: roleMocks.participation }));
const memoryModelMocks = vi.hoisted(() => ({
  memoryTask: vi.fn<(
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
  memoryTask: memoryModelMocks.memoryTask,
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
import {
  rebuildLightMemoryIndex,
  writeLightMemoryFile,
} from '../../../../src/host/lightMemory/lightMemoryIpc';
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
    // N-MEM-WRITECONF：缺省给过门置信度，让存量用例继续走写入路径；
    // 丢弃门行为由下方专项用例覆盖。
    confidence: 0.9,
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

async function runSummaryExtraction(extra: Partial<RuntimeContext> = {}): Promise<void> {
  const finalizer = new RunFinalizer({
    messages: [
      { role: 'user', content: '我在上海，长期住这里。' },
      { role: 'assistant', content: '已了解。' },
    ],
    ...extra,
  } as unknown as RuntimeContext);

  await (finalizer as unknown as SummaryRunner).extractAndSaveConversationSummary();
}

describe('默认助手长期事实写回', () => {
  it.each([true, false])('records role participation while gating only memory write-back (tainted=%s)', async (tainted) => {
    const { AgentLoop } = await import('../../../../src/host/agent/agentLoop');
    roleMocks.writeBack.mockClear();
    roleMocks.participation.mockClear();
    const control = new ControlState();
    if (tainted) control.markMemoryTainted();
    const loop = Object.assign(Object.create(AgentLoop.prototype), {
      ctx: {
        sessionId: 'role-session', persistentRoleId: 'researcher', control,
        messages: [{ id: 'output-1', role: 'assistant', content: 'completed output' }],
      },
      conversationRuntime: { wasInterrupted: () => false },
    });
    loop.schedulePersistentRoleWriteBack('task', new Set());
    await vi.waitFor(() => expect(roleMocks.participation).toHaveBeenCalledWith('role-session', 'researcher'));
    if (tainted) expect(roleMocks.writeBack).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(roleMocks.writeBack).toHaveBeenCalledOnce());
  });

  it('keeps memory taint across external-query counter resets and isolates new runs', () => {
    const state = new ControlState();
    state.markMemoryTainted();
    state.incrementExternalDataCalls();
    state.resetExternalDataCalls();
    expect(state.memoryTainted).toBe(true);
    expect(new ControlState().memoryTainted).toBe(false);
  });

  let tempDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    memoryModelMocks.memoryTask.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-facts-'));
    mockConfigDir.dir = tempDir;
    memoryDir = path.join(tempDir, 'memory');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each(['web-fetch', 'channel', 'paste', 'transcript', 'prior-run'])(
    '%s input cannot write automatic durable facts or summaries', async (source) => {
      clearMemoryInjectionTracesForTest();
      memoryModelMocks.memoryTask.mockResolvedValue(llmResult({ durableFacts: [makeFact(1)] }));
      const control = new ControlState();
      const messages = [{ id: 'u', role: 'user', content: 'External material', timestamp: 1,
        metadata: source === 'channel' ? { channel: { accountId: 'external' } }
          : source === 'paste' ? { workbench: { memoryTainted: true } }
          : source === 'transcript' ? { voiceTranscript: { itemId: 'transcript' } }
          : source === 'prior-run' ? { memoryTainted: true } : undefined,
      }] as RuntimeContext['messages'];
      if (source === 'web-fetch') {
        const registry = vi.spyOn(protocolTools, 'getProtocolToolSchemas').mockReturnValue([webFetchUnifiedSchema]);
        const ctx = { sessionId: '', control, artifact: ArtifactState.forTest(),
          circuitBreaker: { recordSuccess: () => undefined },
          goalTracker: { recordAction: () => undefined },
          antiPatternDetector: { clearToolFailure: () => undefined, trackDuplicateCall: () => undefined },
        } as unknown as RuntimeContext;
        const result = { toolCallId: 'fetch-1', success: true, output: 'External article text' };
        try {
          await handleToolResultBookkeeping({ ctx,
            toolCall: { id: 'fetch-1', name: 'WebFetch', arguments: {} },
            normalizedResult: { success: true, output: result.output }, toolResult: result,
            contextAssembly: {} as never, runtimeControl: {} as never,
          });
          expect(control.memoryTainted).toBe(true);
          expect(result).toMatchObject({ metadata: { memoryTainted: true } });
        } finally { registry.mockRestore(); }
      }
      await runSummaryExtraction({ sessionId: 'taint-test', control, messages });
      expect(await listFactFiles(memoryDir)).toEqual([]);
      await expect(fs.access(path.join(memoryDir, 'recent-conversations.md'))).rejects.toThrow();
      expect(memoryModelMocks.memoryTask).not.toHaveBeenCalled();
      expect(listMemoryInjectionTraces({ sessionId: 'taint-test' })).toContainEqual(
        expect.objectContaining({ trigger: 'skipped:tainted', source: 'durable_facts', injected: false }),
      );
    },
  );

  it('rechecks taint after the asynchronous judge before writing', async () => {
    const control = new ControlState();
    memoryModelMocks.memoryTask.mockImplementation(async () => {
      control.markMemoryTainted();
      return llmResult({ durableFacts: [makeFact(1)] });
    });
    await runSummaryExtraction({ control, sessionId: 'late-taint' });
    expect(await listFactFiles(memoryDir)).toEqual([]);
  });

  it('判断器返回两条合格事实时写入两个文件并维护索引', async () => {
    memoryModelMocks.memoryTask.mockResolvedValue(llmResult({
      durableFacts: [makeFact(1), makeFact(2)],
    }));

    await runSummaryExtraction();

    await waitForFactFiles(memoryDir, ['fact-1.md', 'fact-2.md']);
    expect(memoryModelMocks.memoryTask).toHaveBeenCalledTimes(1);
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
    memoryModelMocks.memoryTask.mockResolvedValue(llmResult({
      worth: false,
      durableFacts: [makeFact(1)],
    }));

    await runSummaryExtraction();

    expect(await listFactFiles(memoryDir)).toEqual([]);
  });

  it('memory model 降级为 heuristic 时不写入长期事实', async () => {
    memoryModelMocks.memoryTask.mockResolvedValue({ success: false, error: '模型不可用' });

    await runSummaryExtraction();

    expect(await listFactFiles(memoryDir)).toEqual([]);
  });

  it('逐条拒绝非法文件名和类型，同批合法条目照常写入', async () => {
    memoryModelMocks.memoryTask.mockResolvedValue(llmResult({
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
    memoryModelMocks.memoryTask.mockResolvedValue(llmResult({
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

  // ------------------------------------------------------------------------
  // N-MEM-WRITECONF r5（final scope cut）：置信度解析 + 唯一丢弃门 + supersedes 链接。
  // candidate 档已整体移除：≥0.5 的事实按 origin/main 原行为写 active（无 status 行），
  // 与 main 的逐字节一致由 mainReference() 对照钉死。
  // ------------------------------------------------------------------------

  async function readFrontmatter(filename: string): Promise<Record<string, string>> {
    const raw = await fs.readFile(path.join(memoryDir, filename), 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    expect(match).toBeTruthy();
    const meta: Record<string, string> = {};
    for (const line of (match as RegExpMatchArray)[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return meta;
  }

  async function readIndex(): Promise<string> {
    try {
      return await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * origin/main 基线产物：main 的 writeDurableFacts 就是按这个入参形状直调
   * writeLightMemoryFile（不传 status/supersedes）。r5 写入路径的逐字节一致
   * 以它为对照——多出来的任何 frontmatter 行（status/deprecated_by/…）都会红。
   */
  async function mainReference(fact: DurableFact): Promise<string> {
    const file = await writeLightMemoryFile({
      filename: 'main-reference.md',
      name: fact.name,
      description: fact.description,
      type: fact.type,
      content: fact.content,
    });
    return fs.readFile(path.join(memoryDir, file.filename), 'utf-8');
  }

  it('缺失置信度回落保守缺省（不低于丢弃门），不静默丢弃', async () => {
    memoryModelMocks.memoryTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        worth: true,
        isMeeting: false,
        title: '置信度缺省测试',
        worthKnowledge: [],
        durableFacts: [{
          filename: 'fact-1.md',
          name: '事实 1',
          description: '第 1 条长期事实',
          type: 'user',
          content: '长期内容 1',
        }],
      }),
    });

    const judgment = await judgeConversation({ userMessages: ['请记住我的稳定偏好。'] });
    expect(judgment.durableFacts[0].confidence).toBe(SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_MISSING_DEFAULT);
    expect(judgment.durableFacts[0].confidence)
      .toBeGreaterThanOrEqual(SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_DROP_BELOW);
  });

  it.each([
    ['超出上限', 1.5],
    ['低于下限', -0.2],
    ['非数字字符串', 'high' as unknown as number],
    ['NaN', Number.NaN],
  ])('越界置信度（%s）回落保守缺省', async (_label, confidence) => {
    memoryModelMocks.memoryTask.mockResolvedValue(llmResult({
      durableFacts: [makeFact(1, { confidence: confidence as number })],
    }));

    const judgment = await judgeConversation({ userMessages: ['请记住我的稳定偏好。'] });
    expect(judgment.durableFacts[0].confidence).toBe(SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_MISSING_DEFAULT);
  });

  it.each([
    ['路径穿越', '../escape.md'],
    ['缺少扩展名', 'old-fact'],
    ['指向自身', 'fact-1.md'],
    ['非字符串', 42 as unknown as string],
  ])('非法 supersedes（%s）被丢弃，事实本身照常解析', async (_label, supersedes) => {
    memoryModelMocks.memoryTask.mockResolvedValue(llmResult({
      durableFacts: [makeFact(1, { supersedes: supersedes as string })],
    }));

    const judgment = await judgeConversation({ userMessages: ['请记住我的稳定偏好。'] });
    expect(judgment.durableFacts[0].supersedes).toBeUndefined();
    expect(judgment.durableFacts[0].filename).toBe('fact-1.md');
  });

  it('判断器输入附带现有记忆文件清单，供 supersedes 指向真实文件', async () => {
    await writeDurableFacts([makeFact(1)]);
    memoryModelMocks.memoryTask.mockResolvedValue(llmResult({ durableFacts: [] }));

    await judgeConversation({ userMessages: ['随便聊聊。'] });

    const prompt = memoryModelMocks.memoryTask.mock.calls[0][0] as string;
    expect(prompt).toContain('现有记忆文件清单');
    expect(prompt).toContain('- fact-1.md');
  });

  it('r5：低置信度（0.3）事实被丢弃——不落盘、计入 dropped，skipped 只留给写入失败', async () => {
    const result = await writeDurableFacts([makeFact(1, { confidence: 0.3 })]);

    expect(result).toMatchObject({ written: 0, skipped: 0, dropped: 1, active: 0, files: [] });
    expect(await listFactFiles(memoryDir)).toEqual([]);
    expect(await readIndex()).toBe('');
  });

  it('r5：中置信度（0.65）事实照 main 原行为写 active——逐字节与 main 基线一致（无 status 行）', async () => {
    const fact = makeFact(1, { confidence: 0.65 });
    const reference = await mainReference(fact);

    const result = await writeDurableFacts([fact]);

    expect(result).toMatchObject({ written: 1, skipped: 0, dropped: 0, active: 1 });
    expect(result.files).toEqual(['fact-1.md']);
    expect(await fs.readFile(path.join(memoryDir, 'fact-1.md'), 'utf-8')).toBe(reference);
    expect((await readFrontmatter('fact-1.md')).status).toBeUndefined();
    expect(await readIndex()).toContain('[fact-1.md]');
  });

  it('r5：判断器漏给置信度（回落缺省）同样照 main 原行为写入', async () => {
    memoryModelMocks.memoryTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        worth: true,
        isMeeting: false,
        title: '置信度缺省写入测试',
        worthKnowledge: [],
        durableFacts: [{
          filename: 'fact-1.md',
          name: '事实 1',
          description: '第 1 条长期事实',
          type: 'user',
          content: '长期内容 1',
        }],
      }),
    });
    const judgment = await judgeConversation({ userMessages: ['请记住我的稳定偏好。'] });
    const reference = await mainReference(judgment.durableFacts[0]);

    const result = await writeDurableFacts(judgment.durableFacts);

    expect(result).toMatchObject({ written: 1, skipped: 0, dropped: 0, active: 1 });
    expect(await fs.readFile(path.join(memoryDir, 'fact-1.md'), 'utf-8')).toBe(reference);
    expect((await readFrontmatter('fact-1.md')).status).toBeUndefined();
    expect(await readIndex()).toContain('[fact-1.md]');
  });

  it.each([
    ['同名已存在 status=active 文件', 'active'],
    ['同名已存在 status=candidate 文件', 'candidate'],
    ['同名已存在无 status 行的存量文件', undefined],
  ] as const)('r5：%s 被过门事实覆盖时与 main 行为一致（整文件重写、无 status 行、单文件单索引行）', async (_label, preexistingStatus) => {
    await writeLightMemoryFile({
      filename: 'fact-1.md',
      name: '旧名称',
      description: '旧描述',
      type: 'user',
      content: '旧内容',
      ...(preexistingStatus === undefined ? {} : { status: preexistingStatus }),
    });
    const fact = makeFact(1, { confidence: 0.9, content: '新内容' });
    const reference = await mainReference(fact);

    const result = await writeDurableFacts([fact]);

    // main 的语义：writeLightMemoryFile 按名原子覆盖——旧 frontmatter（含 status）
    // 整体被本次写入的元数据替换，新文件没有 status 行，读侧按缺省 active 处理。
    expect(result).toMatchObject({ written: 1, active: 1, skipped: 0, dropped: 0 });
    expect(await listFactFiles(memoryDir)).toContain('fact-1.md');
    expect(await listFactFiles(memoryDir)).toHaveLength(2); // fact-1.md + main-reference.md
    expect(await fs.readFile(path.join(memoryDir, 'fact-1.md'), 'utf-8')).toBe(reference);
    expect((await readFrontmatter('fact-1.md')).status).toBeUndefined();
    expect(await readIndex()).toContain('[fact-1.md]');
  });

  it('r5：supersedes 只记录链接：旧条目逐字节不变、仍 active、仍在 INDEX，链接记在新条目 supersedes 字段', async () => {
    await writeDurableFacts([makeFact(1, { content: '旧认知' })]);
    const rawBefore = await fs.readFile(path.join(memoryDir, 'fact-1.md'), 'utf-8');

    const result = await writeDurableFacts([
      makeFact(2, { confidence: 0.9, supersedes: 'fact-1.md', content: '新认知' }),
    ]);

    // 新条目照常写成（main 形状 + 一行 supersedes 链接）；旧条目不动
    expect(result).toMatchObject({ written: 1, active: 1 });
    expect(await readFrontmatter('fact-2.md')).toMatchObject({ supersedes: 'fact-1.md' });
    expect((await readFrontmatter('fact-2.md')).deprecated_by).toBeUndefined();
    // 旧条目逐字节不变（判断器输出不得归档/改写既有条目）
    expect(await fs.readFile(path.join(memoryDir, 'fact-1.md'), 'utf-8')).toBe(rawBefore);
    expect((await readFrontmatter('fact-1.md')).status).toBeUndefined();
    const index = await readIndex();
    expect(index).toContain('[fact-1.md]');
    expect(index).toContain('[fact-2.md]');
  });

  it.each(['project', 'reference'] as const)(
    'r5：%s 类型 supersedes 同样只记录链接，旧条目不动（无类型门）',
    async (type) => {
      await writeDurableFacts([makeFact(1, { type, content: '旧材料' })]);

      await writeDurableFacts([
        makeFact(2, { type, confidence: 0.9, supersedes: 'fact-1.md', content: '新材料' }),
      ]);

      expect(await readFrontmatter('fact-1.md')).toMatchObject({ type });
      expect(await readFrontmatter('fact-2.md')).toMatchObject({ supersedes: 'fact-1.md' });
      const index = await readIndex();
      expect(index).toContain('[fact-1.md]');
      expect(index).toContain('[fact-2.md]');
    },
  );

  it('r5：非规范化的 supersedes 名字经 sanitize 命中磁盘上的既有文件，链接记规范化名', async () => {
    await writeDurableFacts([makeFact(1, { filename: 'user-city.md', content: '用户住在上海。' })]);

    const result = await writeDurableFacts([
      makeFact(2, { confidence: 0.9, supersedes: 'User City.md', content: '新认知' }),
    ]);

    expect(result).toMatchObject({ written: 1, active: 1 });
    expect(await readFrontmatter('fact-2.md')).toMatchObject({ supersedes: 'user-city.md' });
  });

  it('supersedes 指向不存在的文件时不抛错，新条目照常写成且不记链接', async () => {
    await expect(writeDurableFacts([
      makeFact(1, { confidence: 0.9, supersedes: 'ghost.md' }),
    ])).resolves.toMatchObject({ written: 1, active: 1, files: ['fact-1.md'] });
    const meta = await readFrontmatter('fact-1.md');
    expect(meta.status).toBeUndefined();
    expect(meta.supersedes).toBeUndefined();
  });

  // ------------------------------------------------------------------------
  // N-MEM-WRITECONF r4/r5：本 PR 没有任何「判断器输出 → 归档旧条目」的路径，supersedes
  // 只记录链接。directive 经交互确认门建立，这里钉住它在被 supersedes 指向时
  // 逐字节不变、仍在 INDEX。
  // ------------------------------------------------------------------------

  /** 按交互确认门的产物形状种一条 directive（生产路径只有那里能传确认旗标）。 */
  async function seedDirective(filename: string, content: string): Promise<string> {
    await writeLightMemoryFile({
      filename,
      name: '操作指令',
      description: '经用户交互确认的操作指令',
      type: 'directive',
      content,
      status: 'active',
      directiveConfirmedByUser: true,
    });
    await rebuildLightMemoryIndex();
    return fs.readFile(path.join(memoryDir, filename), 'utf-8');
  }

  it('supersedes 指向 directive：只记链接，directive 逐字节不变、仍在 INDEX', async () => {
    const rawBefore = await seedDirective('no-destructive-commands.md', '禁止主动执行任何形式的 rm -rf。');
    expect(await readIndex()).toContain('[no-destructive-commands.md]');

    const result = await writeDurableFacts([
      makeFact(2, {
        type: 'feedback',
        confidence: 0.9,
        supersedes: 'no-destructive-commands.md',
        content: '用户话里好像不排斥破坏性命令',
      }),
    ]);

    // 新事实照常写成（链接照记）；directive 完全不动（内容逐字节一致），仍在 INDEX
    expect(result).toMatchObject({ written: 1, active: 1, skipped: 0 });
    expect(await readFrontmatter('fact-2.md')).toMatchObject({
      supersedes: 'no-destructive-commands.md',
    });
    expect(await fs.readFile(path.join(memoryDir, 'no-destructive-commands.md'), 'utf-8')).toBe(rawBefore);
    expect(await readFrontmatter('no-destructive-commands.md')).toMatchObject({
      status: 'active',
      type: 'directive',
    });
    const index = await readIndex();
    expect(index).toContain('[no-destructive-commands.md]');
    expect(index).toContain('[fact-2.md]');
  });

  it('判断器的现有记忆文件清单不含 directive 条目，且 prompt 声明其不可被 supersedes', async () => {
    await seedDirective('no-destructive-commands.md', '禁止主动执行任何形式的 rm -rf。');
    await writeDurableFacts([makeFact(1)]);
    memoryModelMocks.memoryTask.mockResolvedValue(llmResult({ durableFacts: [] }));

    await judgeConversation({ userMessages: ['随便聊聊。'] });

    const prompt = memoryModelMocks.memoryTask.mock.calls[0][0] as string;
    expect(prompt).toContain('- fact-1.md');
    expect(prompt).not.toContain('- no-destructive-commands.md');
    expect(prompt).toContain('supersedes 永远不许指向 directive');
  });
});
