import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistGenerativeUiEdit,
  setGenerativeUiEditProjectionInvalidator,
} from '../../../../src/host/services/generativeUI/generativeUIEditPersistence';
import { getSessionManager } from '../../../../src/host/services/infra/sessionManager';
import { getTaskManager } from '../../../../src/host/task';
import { hashGenerativeUiBody, extractGenerativeUiFenceBody } from '../../../../src/shared/generativeUIEdit';

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: vi.fn(),
}));
vi.mock('../../../../src/host/task', () => ({
  getTaskManager: vi.fn(),
}));

const ORIGINAL_BODY = '<h1>季度复盘</h1>';
function makeContent(body: string): string {
  return `说明。\n\n\`\`\`generative_ui\n${body}\n\`\`\`\n\n结尾。`;
}

const SESSION_ID = 'sess-1';
const MESSAGE_ID = 'msg-1';

let store: Array<{ id: string; role: string; content: string }>;
let updateMessage: ReturnType<typeof vi.fn>;
let setSessionContext: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store = [{ id: MESSAGE_ID, role: 'assistant', content: makeContent(ORIGINAL_BODY) }];
  updateMessage = vi.fn(async (id: string, updates: { content: string }) => {
    const target = store.find((m) => m.id === id);
    if (target) target.content = updates.content; // 让第二次 getMessages 读到新内容
  });
  setSessionContext = vi.fn();

  vi.mocked(getSessionManager).mockReturnValue({
    getMessages: vi.fn(async () => store.map((m) => ({ ...m }))),
    updateMessage,
  } as never);
  vi.mocked(getTaskManager).mockReturnValue({ setSessionContext } as never);
});

function baseReq(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    messageId: MESSAGE_ID,
    sourceOrdinal: 0,
    baseHash: hashGenerativeUiBody(ORIGINAL_BODY),
    newCode: '<h1>Q3 复盘</h1>',
    fields: ['text'],
    ...overrides,
  };
}

describe('persistGenerativeUiEdit 三处一起写', () => {
  it('对账通过：写库 + 贴标记 + 回灌活跃 orchestrator', async () => {
    const result = await persistGenerativeUiEdit(baseReq(), () => '2026-07-24');
    expect(result).toEqual({ persisted: true });

    // 1) 写库：fence 0 被换成新正文
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const written = updateMessage.mock.calls[0][1].content as string;
    const body = extractGenerativeUiFenceBody(written, 0)!;
    expect(body).toContain('<h1>Q3 复盘</h1>');
    expect(body).not.toContain('季度复盘');
    // 3) 编辑标记贴上了，带注入的日期和 fields
    expect(body).toMatch(/<!-- neo:user-edited 2026-07-24 fields=text -->/);
    // 正文其余部分没动
    expect(written).toContain('说明。');
    expect(written).toContain('结尾。');
  });

  it('写库后让 web 消息投影失效——web /run 读投影不读 DB，不失效就是崩法 A', async () => {
    const invalidate = vi.fn();
    setGenerativeUiEditProjectionInvalidator(invalidate);
    try {
      await persistGenerativeUiEdit(baseReq(), () => '2026-07-24');
      expect(invalidate).toHaveBeenCalledWith(SESSION_ID);
    } finally {
      setGenerativeUiEditProjectionInvalidator(() => {});
    }
  });

  it('对账没过时不碰投影（没写库就没有可失效的东西）', async () => {
    store[0].content = makeContent('<h1>别人改的</h1>');
    const invalidate = vi.fn();
    setGenerativeUiEditProjectionInvalidator(invalidate);
    try {
      await persistGenerativeUiEdit(baseReq(), () => '2026-07-24');
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      setGenerativeUiEditProjectionInvalidator(() => {});
    }
  });

  it('回灌读的是写库之后的最新消息，不是旧副本（防崩法 A）', async () => {
    await persistGenerativeUiEdit(baseReq(), () => '2026-07-24');

    expect(setSessionContext).toHaveBeenCalledTimes(1);
    const [sid, messages] = setSessionContext.mock.calls[0];
    expect(sid).toBe(SESSION_ID);
    // 回灌进 orchestrator 的那份必须已经是改过的——否则模型下一轮还读旧版
    const inflated = (messages as Array<{ id: string; content: string }>).find((m) => m.id === MESSAGE_ID)!;
    expect(inflated.content).toContain('Q3 复盘');
    expect(inflated.content).not.toContain('季度复盘');
  });

  it('对账没过（库里被人改过）→ fail-closed，一个字节都不写', async () => {
    store[0].content = makeContent('<h1>别人改的版本</h1>');
    const result = await persistGenerativeUiEdit(baseReq(), () => '2026-07-24');
    expect(result).toEqual({ persisted: false, reason: 'conflict' });
    expect(updateMessage).not.toHaveBeenCalled();
    expect(setSessionContext).not.toHaveBeenCalled();
  });

  it('ordinal 越界 → 不写', async () => {
    const result = await persistGenerativeUiEdit(baseReq({ sourceOrdinal: 3, baseHash: hashGenerativeUiBody('x') }), () => '2026-07-24');
    expect(result).toEqual({ persisted: false, reason: 'ordinal_out_of_range' });
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('消息不存在 → 不写', async () => {
    const result = await persistGenerativeUiEdit(baseReq({ messageId: 'nope', baseHash: 'no-such-hash' }), () => '2026-07-24');
    expect(result).toEqual({ persisted: false, reason: 'message_not_found' });
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('messageId 对不上（流式 fresh 消息 id ≠ DB id）→ 用 baseHash 内容寻址兜底，仍写对那条', async () => {
    // renderer 传了个 DB 里不存在的 id，但 baseHash 指向真实那条
    const result = await persistGenerativeUiEdit(
      baseReq({ messageId: 'stale-streaming-id' }),
      () => '2026-07-24',
    );
    expect(result).toEqual({ persisted: true });
    // 写的是 DB 真 id，不是传进来的 stale id
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0][0]).toBe(MESSAGE_ID);
    expect(updateMessage.mock.calls[0][1].content).toContain('Q3 复盘');
  });

  it('newCode 里带着上一轮的旧标记时不堆叠——只留一条新鲜的', async () => {
    const req = baseReq({
      newCode: '<!-- neo:user-edited 2026-07-01 fields=color -->\n<h1>Q3 复盘</h1>',
    });
    await persistGenerativeUiEdit(req, () => '2026-07-24');
    const written = updateMessage.mock.calls[0][1].content as string;
    expect((written.match(/neo:user-edited/g) ?? []).length).toBe(1);
    expect(written).toContain('2026-07-24');
    expect(written).not.toContain('2026-07-01');
  });
});
