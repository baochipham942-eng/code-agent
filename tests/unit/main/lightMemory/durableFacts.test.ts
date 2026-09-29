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
    // N-MEM-WRITECONF：缺省给高置信度，让存量用例继续走 active 路径；
    // 分层（drop/candidate）行为由下方专项用例覆盖。
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
  // N-MEM-WRITECONF：置信度解析 + 分层写入 + supersedes
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

  it('缺失置信度回落保守缺省（candidate 区间），不放大成 active', async () => {
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
    expect(judgment.durableFacts[0].confidence)
      .toBeLessThan(SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_ACTIVE_MIN);
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

  it('低置信度事实被丢弃：不落盘、计入 skipped 与 dropped', async () => {
    const result = await writeDurableFacts([makeFact(1, { confidence: 0.3 })]);

    expect(result).toMatchObject({ written: 0, skipped: 1, dropped: 1, active: 0, candidate: 0, files: [] });
    expect(await listFactFiles(memoryDir)).toEqual([]);
    expect(await readIndex()).toBe('');
  });

  it('中置信度事实写 candidate：frontmatter status=candidate 且不进 active INDEX', async () => {
    const result = await writeDurableFacts([makeFact(1, { confidence: 0.65 })]);

    expect(result).toMatchObject({ written: 1, skipped: 0, dropped: 0, candidate: 1, active: 0 });
    expect(result.files).toEqual(['fact-1.md']);
    expect(await readFrontmatter('fact-1.md')).toMatchObject({ status: 'candidate' });
    const index = await readIndex();
    expect(index).not.toContain('[fact-1.md]');
  });

  it('高置信度事实写 active：frontmatter status=active 且进 active INDEX', async () => {
    const result = await writeDurableFacts([makeFact(1, { confidence: 0.9 })]);

    expect(result).toMatchObject({ written: 1, skipped: 0, dropped: 0, active: 1, candidate: 0 });
    expect(await readFrontmatter('fact-1.md')).toMatchObject({ status: 'active' });
    expect(await readIndex()).toContain('[fact-1.md]');
  });

  it('user 类型 supersedes：新条目写成 active 后软归档旧条目（deprecated_by 指向新文件）', async () => {
    await writeDurableFacts([makeFact(1, { content: '旧认知' })]);

    const result = await writeDurableFacts([
      makeFact(2, { confidence: 0.9, supersedes: 'fact-1.md', content: '新认知' }),
    ]);

    expect(result).toMatchObject({ written: 1, active: 1 });
    expect(await readFrontmatter('fact-2.md')).toMatchObject({ status: 'active' });
    const old = await readFrontmatter('fact-1.md');
    expect(old.status).toBe('archived');
    expect(old.deprecated_by).toBe('fact-2.md');
    // 归档后的旧条目退出 active INDEX，新条目在
    const index = await readIndex();
    expect(index).toContain('[fact-2.md]');
    expect(index).not.toContain('[fact-1.md]');
  });

  it.each(['project', 'reference'] as const)(
    '%s 类型 supersedes 不归档旧条目',
    async (type) => {
      await writeDurableFacts([makeFact(1, { type, content: '旧材料' })]);

      await writeDurableFacts([
        makeFact(2, { type, confidence: 0.9, supersedes: 'fact-1.md', content: '新材料' }),
      ]);

      expect(await readFrontmatter('fact-1.md')).toMatchObject({ status: 'active' });
      const index = await readIndex();
      expect(index).toContain('[fact-1.md]');
      expect(index).toContain('[fact-2.md]');
    },
  );

  it('candidate 新条目不归档旧条目：旧条目保持生效直到复核转正', async () => {
    await writeDurableFacts([makeFact(1, { content: '旧认知' })]);

    const result = await writeDurableFacts([
      makeFact(2, { confidence: 0.65, supersedes: 'fact-1.md', content: '待确认的新认知' }),
    ]);

    expect(result).toMatchObject({ candidate: 1, active: 0 });
    expect(await readFrontmatter('fact-2.md')).toMatchObject({ status: 'candidate' });
    expect(await readFrontmatter('fact-1.md')).toMatchObject({ status: 'active' });
    const index = await readIndex();
    expect(index).toContain('[fact-1.md]');
    expect(index).not.toContain('[fact-2.md]');
  });

  it('supersedes 指向不存在的文件时不抛错，新条目照常写成', async () => {
    await expect(writeDurableFacts([
      makeFact(1, { confidence: 0.9, supersedes: 'ghost.md' }),
    ])).resolves.toMatchObject({ written: 1, active: 1, files: ['fact-1.md'] });
    expect(await readFrontmatter('fact-1.md')).toMatchObject({ status: 'active' });
  });

  // ------------------------------------------------------------------------
  // N-MEM-WRITECONF r3：supersedes 归档的旧条目类型门——directive 经交互确认门建立，
  // 任务性材料（project/reference）不代表失效，都不能被会话收尾的一次模型判断归档。
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

  it('r3：directive 旧条目不可被自动 supersedes 归档：保持 active、逐字节不变、仍在 INDEX', async () => {
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

    // 新事实照常写成 active；directive 完全不动（内容逐字节一致），仍在 INDEX
    expect(result).toMatchObject({ written: 1, active: 1, skipped: 0 });
    expect(await fs.readFile(path.join(memoryDir, 'no-destructive-commands.md'), 'utf-8')).toBe(rawBefore);
    expect(await readFrontmatter('no-destructive-commands.md')).toMatchObject({
      status: 'active',
      type: 'directive',
    });
    const index = await readIndex();
    expect(index).toContain('[no-destructive-commands.md]');
    expect(index).toContain('[fact-2.md]');
  });

  it.each(['project', 'reference'] as const)(
    'r3：旧条目为 %s（新条目 user）时 supersedes 同样不归档——旧条目类型门生效',
    async (oldType) => {
      await writeDurableFacts([makeFact(1, { type: oldType, content: '旧材料' })]);
      expect(await readFrontmatter('fact-1.md')).toMatchObject({ status: 'active' });

      await writeDurableFacts([
        makeFact(2, { type: 'user', confidence: 0.9, supersedes: 'fact-1.md', content: '新认知' }),
      ]);

      // 旧 project/reference 条目不被 user 新条目自动顶替：仍 active、双条目都在 INDEX
      expect(await readFrontmatter('fact-1.md')).toMatchObject({ status: 'active' });
      const index = await readIndex();
      expect(index).toContain('[fact-1.md]');
      expect(index).toContain('[fact-2.md]');
    },
  );

  it('r3：判断器的现有记忆文件清单不含 directive 条目，且 prompt 声明其不可被 supersedes', async () => {
    await seedDirective('no-destructive-commands.md', '禁止主动执行任何形式的 rm -rf。');
    await writeDurableFacts([makeFact(1)]);
    memoryModelMocks.memoryTask.mockResolvedValue(llmResult({ durableFacts: [] }));

    await judgeConversation({ userMessages: ['随便聊聊。'] });

    const prompt = memoryModelMocks.memoryTask.mock.calls[0][0] as string;
    expect(prompt).toContain('- fact-1.md');
    expect(prompt).not.toContain('- no-destructive-commands.md');
    expect(prompt).toContain('supersedes 永远不许指向 directive');
  });

  // ------------------------------------------------------------------------
  // N-MEM-WRITECONF r3（Nit 1）：同名检测与写入共用 sanitize 规范化，
  // 派生文件名为 hash 后缀预留写入侧 96 字符预算。
  // ------------------------------------------------------------------------

  it('r3：非规范化文件名（大小写/空格）撞上同名 active 条目时，candidate 仍不原地覆盖', async () => {
    await writeDurableFacts([
      makeFact(1, { filename: 'user-city.md', confidence: 0.9, content: '用户住在上海。' }),
    ]);

    const result = await writeDurableFacts([
      makeFact(1, { filename: 'User City.md', confidence: 0.65, content: '用户住在北京。' }),
    ]);

    // 查找按写入侧 sanitize 命中 user-city.md → 改写派生文件名而不是覆盖旧条目
    expect(result.files[0]).toMatch(/^user-city\.candidate-[0-9a-f]{8}\.md$/);
    expect(await readFrontmatter('user-city.md')).toMatchObject({ status: 'active' });
    const oldRaw = await fs.readFile(path.join(memoryDir, 'user-city.md'), 'utf-8');
    expect(oldRaw).toContain('用户住在上海。');
    expect(oldRaw).not.toContain('北京');
    expect(await readFrontmatter(result.files[0])).toMatchObject({
      status: 'candidate',
      deprecated_by: 'user-city.md',
    });
  });

  it('r3：超长同名 active 条目的派生文件名保留 hash 后缀（写入侧 96 字符预算内不截断）', async () => {
    await writeDurableFacts([
      makeFact(1, { filename: `${'a'.repeat(120)}.md`, confidence: 0.9, content: '用户住在上海。' }),
    ]);
    const onDisk = (await listFactFiles(memoryDir))[0];
    // 写入侧 sanitize 把去扩展名部分截到 96
    expect(onDisk).toHaveLength(96 + '.md'.length);

    const result = await writeDurableFacts([
      makeFact(1, { filename: onDisk, confidence: 0.65, content: '用户住在北京。' }),
    ]);

    const derived = result.files[0];
    expect(derived).toMatch(/\.candidate-[0-9a-f]{8}\.md$/);
    expect(derived.slice(0, -'.md'.length)).toHaveLength(96);
    // 旧条目原封不动，candidate 落在独立派生文件上
    expect(await readFrontmatter(onDisk)).toMatchObject({ status: 'active' });
    expect(await readFrontmatter(derived)).toMatchObject({
      status: 'candidate',
      deprecated_by: onDisk,
    });
  });
});
