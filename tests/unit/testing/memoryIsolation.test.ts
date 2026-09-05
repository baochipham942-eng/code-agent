// N-EVAL-MEMORY 隔离两向：
//   (a) 评测默认 persistLongTermMemory=false 时，writeDurableFacts 与 recordSessionEnd 都不被调用；
//   (b) 记忆目录跟 CODE_AGENT_DATA_DIR 走 —— 事件桥每题 mkdtemp 出来的目录就是本题的记忆库，
//       评测碰不到用户真实的 ~/.code-agent/memory。
// 这两条是「记忆题不污染生产记忆」的全部依据，所以要钉死，不能只靠读代码。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

const memoryCalls = vi.hoisted(() => ({
  writeDurableFacts: vi.fn(async () => ({ written: 1, skipped: 0, files: ['mem-fact.md'] })),
  recordSessionEnd: vi.fn(async () => undefined),
  appendConversationSummary: vi.fn(async () => undefined),
  judgeConversation: vi.fn(async () => ({
    worth: true,
    source: 'llm' as const,
    title: 'T',
    isMeeting: false,
    worthKnowledge: ['k'],
    durableFacts: [{ filename: 'mem-fact.md', name: 'n', description: 'd', type: 'reference', content: 'c' }],
  })),
}));

vi.mock('../../../src/host/lightMemory/durableFactWriter', () => ({
  writeDurableFacts: memoryCalls.writeDurableFacts,
}));
vi.mock('../../../src/host/lightMemory/sessionMetadata', () => ({
  recordSessionEnd: memoryCalls.recordSessionEnd,
  appendConversationSummary: memoryCalls.appendConversationSummary,
  buildSessionMetadataBlock: () => null,
}));
vi.mock('../../../src/host/lightMemory/conversationJudge', () => ({
  judgeConversation: memoryCalls.judgeConversation,
}));

import { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import { getMemoryDir } from '../../../src/host/lightMemory/indexLoader';
import { EVAL_AGENT_DEFAULTS } from '../../../src/host/testing/agentAdapter';

class ProbeFinalizer extends RunFinalizer {
  /**
   * 调的是产线那一闸本身（RunFinalizer.persistSessionEndMemory），不是它的复制品——
   * 把闸拿掉，下面几条必须转红，否则这个测试没咬住任何东西。
   */
  async runSessionEndMemory(): Promise<void> {
    this.persistSessionEndMemory();
    await this.whenSessionEndMemoryWorkSettled();
  }
}

function makeFinalizer(persistLongTermMemory: boolean): ProbeFinalizer {
  return new ProbeFinalizer({
    sessionId: 'sess-memory-isolation',
    persistLongTermMemory,
    modelConfig: { model: 'm', provider: 'p' },
    messages: [{ id: 'u1', role: 'user', content: '记一下 Beacon 的周会时间', timestamp: 1 }],
    onEvent: vi.fn(),
  } as never);
}

describe('记忆隔离 (a)：评测默认关记忆时写入侧一次都不被调用', () => {
  beforeEach(() => vi.clearAllMocks());

  it('评测默认就是关的（EVAL_AGENT_DEFAULTS 是这条链的起点）', () => {
    expect(EVAL_AGENT_DEFAULTS.persistLongTermMemory).toBe(false);
    expect(EVAL_AGENT_DEFAULTS.includeRecentConversations).toBe(false);
  });

  it('persistLongTermMemory=false ⇒ recordSessionEnd 与 writeDurableFacts 都不被调用', async () => {
    await makeFinalizer(false).runSessionEndMemory();
    expect(memoryCalls.recordSessionEnd).not.toHaveBeenCalled();
    expect(memoryCalls.writeDurableFacts).not.toHaveBeenCalled();
    expect(memoryCalls.appendConversationSummary).not.toHaveBeenCalled();
  });

  it('persistLongTermMemory=true ⇒ 两处都真的会被调用（证明上一条不是因为路径本来就死）', async () => {
    await makeFinalizer(true).runSessionEndMemory();
    expect(memoryCalls.recordSessionEnd).toHaveBeenCalledTimes(1);
    expect(memoryCalls.writeDurableFacts).toHaveBeenCalledTimes(1);
  });

  it('开着记忆写成功后发 memory_written 事件（评测的写入侧信号来源）', async () => {
    const onEvent = vi.fn();
    const finalizer = new ProbeFinalizer({
      sessionId: 'sess-memory-isolation',
      persistLongTermMemory: true,
      modelConfig: { model: 'm', provider: 'p' },
      messages: [{ id: 'u1', role: 'user', content: '记一下 Beacon 的周会时间', timestamp: 1 }],
      onEvent,
    } as never);
    await finalizer.runSessionEndMemory();
    expect(onEvent).toHaveBeenCalledWith({
      type: 'memory_written',
      data: { files: ['mem-fact.md'], written: 1 },
    });
  });

  it('一条都没写成时不发事件（written:0 不能被记成一次写入）', async () => {
    memoryCalls.writeDurableFacts.mockResolvedValueOnce({ written: 0, skipped: 1, files: [] });
    const onEvent = vi.fn();
    const finalizer = new ProbeFinalizer({
      sessionId: 'sess-memory-isolation',
      persistLongTermMemory: true,
      modelConfig: { model: 'm', provider: 'p' },
      messages: [{ id: 'u1', role: 'user', content: '记一下 Beacon 的周会时间', timestamp: 1 }],
      onEvent,
    } as never);
    await finalizer.runSessionEndMemory();
    expect(onEvent.mock.calls.filter(([event]) => event.type === 'memory_written')).toHaveLength(0);
  });
});

describe('记忆隔离 (b)：记忆目录跟 CODE_AGENT_DATA_DIR 走', () => {
  let previous: string | undefined;
  let caseDir: string;

  beforeEach(() => {
    previous = process.env.CODE_AGENT_DATA_DIR;
    caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-isolation-case-'));
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previous;
    fs.rmSync(caseDir, { recursive: true, force: true });
  });

  it('指向本题目录时记忆库落在本题目录下', () => {
    process.env.CODE_AGENT_DATA_DIR = caseDir;
    expect(getMemoryDir()).toBe(path.join(caseDir, 'memory'));
  });

  it('换一题换一个目录，两题的记忆库不共享', () => {
    process.env.CODE_AGENT_DATA_DIR = caseDir;
    const first = getMemoryDir();
    const secondCase = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-isolation-case-'));
    try {
      process.env.CODE_AGENT_DATA_DIR = secondCase;
      expect(getMemoryDir()).not.toBe(first);
    } finally {
      fs.rmSync(secondCase, { recursive: true, force: true });
    }
  });

  it('未设置时才回落到用户真实数据目录（正是记忆题必须拒绝起跑的那一档）', () => {
    delete process.env.CODE_AGENT_DATA_DIR;
    expect(getMemoryDir()).toBe(path.join(os.homedir(), '.code-agent', 'memory'));
  });
});
