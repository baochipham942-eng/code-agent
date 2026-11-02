import { describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import type { ChannelResponseCallback } from '../../../src/host/channels/channelInterface';
import { ChannelAgentBridge } from '../../../src/host/channels/channelAgentBridge';
import {
  buildChannelAckText,
  resolveChannelReplyLimit,
  softLimitChannelReply,
} from '../../../src/host/channels/channelReplyBrevity';
import { evaluateNotificationPolicy } from '../../../src/host/services/infra/notificationPolicy';

vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({ getAllToolDefinitions: () => [] }));

interface Harness {
  handleSyncMessage(a: string, m: ChannelMessage, o: unknown, att: undefined, cb: ChannelResponseCallback): Promise<void>;
  channelSessions: Map<string, string>;
  busyHintedSessions: Set<string>;
  getSessionKey(accountId: string, message: ChannelMessage): string;
}

const CHANNEL_REPLY_FULL_TEXT_NOTE = '（完整内容见 Neo 会话）';
const CHANNEL_REPLY_STYLE_INSTRUCTION = '[IM 回复纪律]';

const message: ChannelMessage = {
  id: 'm1', channelId: 'feishu-1', sender: { id: 'u', name: 'U' },
  context: { chatId: 'c', chatType: 'p2p' }, content: 'do it', timestamp: 1,
};

async function runSync(reply: string, events: string[] = [], overrides: Partial<ChannelMessage> = {}) {
  const sendText = vi.fn(async () => ({ success: true }));
  const typing = vi.fn();
  const cb: ChannelResponseCallback = { sendText, startTyping: typing, stopTyping: typing };
  const orchestrator = {
    getMessages: vi.fn().mockReturnValueOnce([]).mockReturnValueOnce([{ role: 'assistant', content: reply }]),
    // fake event stream: progress/stream events happen during the run and must not reach the channel
    sendMessage: vi.fn(async () => { events.push('message_delta', 'tool_call_start', 'progress'); }),
  };
  const bridge = new ChannelAgentBridge({ configService: {} as never });
  const runMessage = { ...message, ...overrides };
  await (bridge as unknown as Harness).handleSyncMessage('acc', runMessage, orchestrator, undefined, cb);
  return { sendText, orchestrator, bridge, runMessage };
}

describe('N-CHANNEL-REPLY-BREVITY', () => {
  it('① bridge hands the orchestrator the original content plus channel metadata; the instruction block stays out of the stored user message', async () => {
    const { orchestrator, runMessage } = await runSync('ok');
    const [sentContent, , , metadata] = orchestrator.sendMessage.mock.calls[0] as unknown as [string, unknown, unknown, { channel?: unknown }];
    // 存库/展示的用户消息 = 原话：指令在 orchestrator 侧按 metadata.channel 于推理期注入，
    // 不再拼进 content（桌面气泡/标题/记忆读的都是这条 content）。
    expect(sentContent).toBe('do it');
    expect(sentContent).not.toContain(CHANNEL_REPLY_STYLE_INSTRUCTION);
    expect(metadata?.channel).toEqual(expect.objectContaining({ chatId: 'c', messageId: 'm1' }));
    expect(runMessage.content).toBe('do it');
  });

  it('② 900-char reply is cut at a paragraph boundary with the full-text line', async () => {
    const long = `${'结论'.repeat(40)}\n\n${'细节'.repeat(400)}`;
    expect(long.length).toBeGreaterThan(850);
    const { sendText } = await runSync(long);
    const sent = (sendText.mock.calls.at(-1) as unknown[])[0] as string;
    expect(sent).toBe(`${'结论'.repeat(40)}\n\n${CHANNEL_REPLY_FULL_TEXT_NOTE}`);
    expect(sent.length).toBeLessThan(150);
  });

  it('② 120-char reply passes untouched', async () => {
    const short = '好'.repeat(120);
    const { sendText } = await runSync(short);
    expect((sendText.mock.calls.at(-1) as unknown[])[0]).toBe(short);
  });

  it('② soft-limited text stays under the Telegram 4096 max, so splitMessage only fires beyond it', () => {
    const huge = '句子。'.repeat(3000);
    const limited = softLimitChannelReply(huge, 150);
    expect(limited.length).toBeLessThan(4096);
    expect(limited.endsWith(CHANNEL_REPLY_FULL_TEXT_NOTE)).toBe(true);
    // a configured limit above the platform max can still yield >4096 → split is the last fallback
    expect(softLimitChannelReply('甲'.repeat(5000), 5000).length).toBe(5000);
  });

  it('② limit is configurable with a default', () => {
    expect(resolveChannelReplyLimit(undefined)).toBe(150);
    expect(resolveChannelReplyLimit(-1)).toBe(150);
    expect(resolveChannelReplyLimit(300)).toBe(300);
  });

  it('③ a run emits ack + final (2 messages, ≤3 total); progress/typing/stream intents are denied', async () => {
    const events: string[] = [];
    const { sendText } = await runSync('完成', events);
    expect(events.length).toBeGreaterThan(0);
    expect(sendText.mock.calls.length).toBe(2);
    expect(sendText.mock.calls.length).toBeLessThanOrEqual(3);
    expect((sendText.mock.calls[0] as unknown[])[0]).toBe('收到，开始处理：do it');
    expect((sendText.mock.calls[1] as unknown[])[0]).toBe('完成');
    for (const intent of ['progress', 'typing', 'stream_delta', 'tool_started'] as const) {
      expect(evaluateNotificationPolicy(intent).allowed).toBe(false);
    }
    for (const intent of ['needs_input', 'task_complete', 'task_failed'] as const) {
      expect(evaluateNotificationPolicy(intent).allowed).toBe(true);
    }
  });

  it('③ the ack carries at most the first 30 chars of the request', () => {
    expect(buildChannelAckText(undefined, `${'一'.repeat(35)}`)).toBe(`收到，开始处理：${'一'.repeat(30)}…`);
    expect(buildChannelAckText('en-US', 'short one')).toBe('Got it, starting: short one');
    expect(buildChannelAckText(undefined, '   ')).toBe('');
  });

  it('③ guest runs get no ack (final only)', async () => {
    const { sendText } = await runSync('guest reply', [], { ingressAuth: 'guest' });
    expect(sendText.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['guest reply']);
  });

  it('③ a turn that just sent the busy hint gets no ack', async () => {
    const sendText = vi.fn(async () => ({ success: true }));
    const cb: ChannelResponseCallback = { sendText };
    const orchestrator = {
      getMessages: vi.fn().mockReturnValueOnce([]).mockReturnValueOnce([{ role: 'assistant', content: 'later' }]),
      sendMessage: vi.fn(async () => undefined),
    };
    const bridge = new ChannelAgentBridge({ configService: {} as never });
    const harness = bridge as unknown as Harness;
    const sessionId = 'sess-busy';
    harness.channelSessions.set(harness.getSessionKey('acc', message), sessionId);
    harness.busyHintedSessions.add(sessionId);
    await harness.handleSyncMessage('acc', message, orchestrator, undefined, cb);
    expect(sendText.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['later']);
  });
});
