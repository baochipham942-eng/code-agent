// W6-6 发言人协议回归门。
//
// 真机现场（2026-07-28 P0 验收）：执行侧把活干完了，通话里**没人念这句话**；
// 而屏幕上同时出现两个人格——语音层张口就是「后台正在处理」，用户面对的却只有一个 Neo。
//
// 这一批钉四条，每条都对着一个真实失败模式，不是对着字段赋值：
//   1. 只有终态才念，且 cancelled 不念（用户自己叫停的，回头念一遍是噪音）；
//      只读查询（status / recent_files）一句都不许念——它们本来就是问答，念第二遍是复读。
//   2. 长内容不念原文：代码块 / 表格 / 绝对路径 / 超长正文一律换成一句指路。
//   3. 无专家时不署名，也就不可能冒充人格；查不到显示名的 agentId 同样不署名
//      （编一个名字比不署名更糟）。
//   4. prompt 不许把分层暴露给用户：base instructions 里不能出现「后台」「执行侧」，
//      且必须写明 `[BACKEND] ` 前缀不许念出来。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRunOptions } from '../../src/host/research/types';
import { VOICE_NARRATION_MAX_CHARS } from '../../src/shared/constants/voice';

type FakeEvent = { type: string; sessionId: string; data?: unknown };

const runtime = vi.hoisted(() => ({
  listeners: new Set<(event: FakeEvent) => void>(),
  status: 'idle' as string,
  /** 会话里最后一条 assistant 消息 = 这一轮的结论，narrateSettled 回头取的就是它。 */
  conclusion: '',
  startTask: vi.fn(async (
    _sessionId: string,
    _message: string,
    _attachments: unknown,
    _options: AgentRunOptions,
  ) => undefined),
  emit(type: string, sessionId = 'session-1', data?: unknown) {
    for (const listener of [...this.listeners]) listener({ type, sessionId, data });
  },
}));

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.add(listener); },
    off: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.delete(listener); },
    getSessionState: () => ({ status: runtime.status }),
    startTask: runtime.startTask,
    interruptAndContinue: vi.fn(async () => ({ outcome: 'steered' as const })),
    cancelTask: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: vi.fn(async () => '<role/>'),
}));
vi.mock('../../src/host/services/roleAssets/builtinRoles', () => ({
  getBuiltinRoleVisual: (id: string) => (id === 'mu-zhi'
    ? { displayName: '牧之', profession: '产品', tags: [] }
    : undefined),
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ voice: { live: {} } }) }),
}));
vi.mock('../../src/host/services/planning/taskStore', () => ({ getIncompleteTasks: () => [] }));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async () => ({
      messages: runtime.conclusion
        ? [{ role: 'assistant', content: runtime.conclusion }]
        : [],
    }),
  }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    markLiveVoiceSession: vi.fn(),
    clearLiveVoiceSession: vi.fn(),
    isLiveVoiceSession: () => true,
    getModeForSession: () => 'readOnly',
  }),
}));
vi.mock('../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../src/host/connectors', () => ({ getConnectorRegistry: () => ({ get: () => undefined }) }));

const { beginVoiceDispatch, endVoiceDispatch, dispatchVoiceIntent } =
  await import('../../src/host/services/voice/voiceAgentCoordinator');
const { toSpokenSummary, resolveNarrationSpeaker } =
  await import('../../src/host/services/voice/voiceNarration');
const { resolveVoiceRouting } = await import('../../src/host/services/voice/voiceRouting');

type Narration = { workItemId: string; status: string; title: string; summary: string; speaker?: { displayName: string } };

let narrations: Narration[];

function bind(activeAgentId?: string): void {
  narrations = [];
  beginVoiceDispatch({
    neoSessionId: 'session-1',
    ...(activeAgentId ? { activeAgentId } : {}),
    onWorkItem: () => {},
    onWorkFailed: () => {},
    onEndCall: () => {},
    onWorkNarration: (narration) => { narrations.push(narration as Narration); },
  });
}

async function spawn(title = '建个文件'): Promise<void> {
  runtime.status = 'idle';
  await dispatchVoiceIntent({ kind: 'spawn_task', title, prompt: '建一个 a.txt' });
}

/** narrateSettled 是 fire-and-forget 的 async：让它跑完再断言。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  runtime.listeners.clear();
  runtime.startTask.mockClear();
  runtime.conclusion = '';
  endVoiceDispatch();
});

describe('① 只有终态才念，且念的是执行侧的结论', () => {
  it('done 念一句，内容取自这一轮最后一条 assistant 消息', async () => {
    bind();
    await spawn('建个文件');
    runtime.conclusion = '已经建好 a.txt，里面写了一行问候。';
    runtime.emit('task_completed');
    await flush();

    expect(narrations).toHaveLength(1);
    expect(narrations[0].status).toBe('done');
    expect(narrations[0].summary).toBe('已经建好 a.txt，里面写了一行问候。');
  });

  it('cancelled 一句都不念——用户自己叫停的，他知道', async () => {
    bind();
    await spawn();
    runtime.conclusion = '不应该被念出来';
    runtime.emit('task_cancelled');
    await flush();

    expect(narrations).toHaveLength(0);
  });

  it('只读查询（status / recent_files）不产生任何回流', async () => {
    bind();
    await dispatchVoiceIntent({ kind: 'status' });
    await dispatchVoiceIntent({ kind: 'recent_files' });
    await flush();

    expect(narrations).toHaveLength(0);
  });

  it('同一件活的终态事件到两次，只念一次', async () => {
    bind();
    await spawn();
    runtime.conclusion = '做完了。';
    runtime.emit('task_completed');
    runtime.emit('task_completed');
    await flush();

    expect(narrations).toHaveLength(1);
  });

  it('挂断之后才落的终态不再念——电话都挂了，念给谁听', async () => {
    bind();
    await spawn();
    runtime.conclusion = '做完了。';
    endVoiceDispatch();
    runtime.emit('task_completed');
    await flush();

    expect(narrations).toHaveLength(0);
  });
});

describe('② 长内容不念原文', () => {
  it('代码块换成一句指路，原文一个字都不带出来', () => {
    const spoken = toSpokenSummary('改好了，改动如下：\n```ts\nconst secret = 42;\nexport default secret;\n```');
    expect(spoken).not.toContain('const secret');
    expect(spoken).not.toContain('```');
    expect(spoken).toContain('屏幕');
  });

  it('未闭合的代码块同样被吃掉（模型被截断时很常见）', () => {
    const spoken = toSpokenSummary('看这里：\n```python\nimport os\nos.remove(');
    expect(spoken).not.toContain('import os');
  });

  it('markdown 表格换成一句指路', () => {
    const spoken = toSpokenSummary('对比结果：\n| 名称 | 大小 |\n| --- | --- |\n| a.txt | 1KB |');
    expect(spoken).not.toContain('| a.txt |');
    expect(spoken).toContain('屏幕');
  });

  it('绝对路径只留文件名', () => {
    const spoken = toSpokenSummary('已经写到 /Users/foo/Downloads/ai/code-agent/src/index.ts 了');
    expect(spoken).not.toContain('/Users/foo');
    expect(spoken).toContain('index.ts');
  });

  it('超长正文截断并指路屏幕', () => {
    const spoken = toSpokenSummary('好'.repeat(VOICE_NARRATION_MAX_CHARS * 3));
    expect(spoken.length).toBeLessThan(VOICE_NARRATION_MAX_CHARS + 20);
    expect(spoken).toContain('屏幕');
  });

  it('短句原样通过，不做无谓改写', () => {
    expect(toSpokenSummary('建好了。')).toBe('建好了。');
  });
});

describe('③ 署名只在有专家时出现', () => {
  it('无专家 → 不署名（语音层用第一人称，不冒充任何人格）', async () => {
    bind();
    await spawn();
    runtime.conclusion = '做完了。';
    runtime.emit('task_completed');
    await flush();

    expect(narrations[0].speaker).toBeUndefined();
  });

  it('有专家 → 带上这位专家的显示名', async () => {
    bind('mu-zhi');
    await spawn();
    runtime.conclusion = '做完了。';
    runtime.emit('task_completed');
    await flush();

    expect(narrations[0].speaker?.displayName).toBe('牧之');
  });

  it('查不到显示名的 agentId 不署名——编一个名字比不署名更糟', () => {
    expect(resolveNarrationSpeaker('ghost-agent')).toBeUndefined();
    expect(resolveNarrationSpeaker(undefined)).toBeUndefined();
  });

  it('屏幕上的署名与耳朵里听到的同源：派活消息的 voiceDispatch 带同一个 speaker', async () => {
    bind('mu-zhi');
    await spawn('建个文件');

    const metadata = runtime.startTask.mock.calls[0]?.[4] as
      { voiceDispatch?: { title: string; speaker?: { displayName: string } } } | undefined;
    expect(metadata?.voiceDispatch?.speaker?.displayName).toBe('牧之');
  });

  it('无专家时派活消息也不带署名', async () => {
    bind();
    await spawn('建个文件');

    const metadata = runtime.startTask.mock.calls[0]?.[4] as
      { voiceDispatch?: { speaker?: unknown } } | undefined;
    expect(metadata?.voiceDispatch?.speaker).toBeUndefined();
  });
});

describe('④ prompt 不许把分层暴露给用户', () => {
  const instructions = resolveVoiceRouting().personaInstructions;

  it('不出现「后台」「执行侧」这类把双层说给用户听的词', () => {
    // 唯一允许出现这两个词的地方是「绝不说……」那条禁令本身——它必须把词列出来才能禁。
    // 除此之外一个都不许有：真机那次模型张口就说「后台正在处理」，学的正是 prompt 自己的用词。
    const leaked = instructions
      .split('\n')
      .filter((line) => !line.includes('绝不说'))
      .filter((line) => line.includes('后台') || line.includes('执行侧'));
    expect(leaked).toEqual([]);
  });

  it('明写第一人称，且 [BACKEND] 前缀不许念出来', () => {
    expect(instructions).toContain('第一人称');
    expect(instructions).toContain('[BACKEND] ');
    expect(instructions).toContain('不要念出这个前缀');
  });

  it('长内容不念原文这条规则真的写进了 prompt', () => {
    expect(instructions).toContain('只念结论');
  });
});
