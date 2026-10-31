import { describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import type { ChannelResponseCallback } from '../../../src/host/channels/channelInterface';
import { ChannelAgentBridge } from '../../../src/host/channels/channelAgentBridge';
import {
  CHANNEL_REPLY_FULL_TEXT_NOTE,
  CHANNEL_REPLY_STYLE_INSTRUCTION,
  buildChannelRunContent,
  resolveChannelReplyLimit,
  softLimitChannelReply,
} from '../../../src/host/channels/channelReplyBrevity';
import { evaluateNotificationPolicy } from '../../../src/host/services/infra/notificationPolicy';

vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({ getAllToolDefinitions: () => [] }));

interface Harness {
  handleSyncMessage(a: string, m: ChannelMessage, o: unknown, att: undefined, cb: ChannelResponseCallback): Promise<void>;
}

const message: ChannelMessage = {
  id: 'm1', channelId: 'feishu-1', sender: { id: 'u', name: 'U' },
  context: { chatId: 'c', chatType: 'p2p' }, content: 'do it', timestamp: 1,
};

async function runSync(reply: string, events: string[] = []) {
  const sendText = vi.fn(async () => ({ success: true }));
  const typing = vi.fn();
  const cb: ChannelResponseCallback = { sendText, startTyping: typing, stopTyping: typing };
  const orchestrator = {
    getMessages: vi.fn().mockReturnValueOnce([]).mockReturnValueOnce([{ role: 'assistant', content: reply }]),
    // fake event stream: progress/stream events happen during the run and must not reach the channel
    sendMessage: vi.fn(async () => { events.push('message_delta', 'tool_call_start', 'progress'); }),
  };
  const bridge = new ChannelAgentBridge({ configService: {} as never });
  await (bridge as unknown as Harness).handleSyncMessage('acc', message, orchestrator, undefined, cb);
  return { sendText, orchestrator };
}

describe('N-CHANNEL-REPLY-BREVITY', () => {
  it('① channel runs get the reply-style instruction; plain content (desktop) does not', async () => {
    const { orchestrator } = await runSync('ok');
    const sent = (orchestrator.sendMessage.mock.calls[0] as unknown[])[0] as string;
    expect(sent).toBe(buildChannelRunContent('do it'));
    expect(sent).toContain(CHANNEL_REPLY_STYLE_INSTRUCTION);
    expect(message.content).toBe('do it');
    expect(message.content).not.toContain('IM 回复纪律');
  });

  it('② 900-char reply is cut at a paragraph boundary with the full-text line', async () => {
    const long = `${'结论'.repeat(40)}\n\n${'细节'.repeat(400)}`;
    expect(long.length).toBeGreaterThan(850);
    const { sendText } = await runSync(long);
    const sent = (sendText.mock.calls[0] as unknown[])[0] as string;
    expect(sent).toBe(`${'结论'.repeat(40)}\n\n${CHANNEL_REPLY_FULL_TEXT_NOTE}`);
    expect(sent.length).toBeLessThan(150);
  });

  it('② 120-char reply passes untouched', async () => {
    const short = '好'.repeat(120);
    const { sendText } = await runSync(short);
    expect(sendText).toHaveBeenCalledWith(short);
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

  it('③ a run emits exactly one channel message; progress/typing/stream intents are denied', async () => {
    const events: string[] = [];
    const { sendText } = await runSync('完成', events);
    expect(events.length).toBeGreaterThan(0);
    expect(sendText).toHaveBeenCalledTimes(1);
    for (const intent of ['progress', 'typing', 'stream_delta', 'tool_started'] as const) {
      expect(evaluateNotificationPolicy(intent).allowed).toBe(false);
    }
    for (const intent of ['needs_input', 'task_complete', 'task_failed'] as const) {
      expect(evaluateNotificationPolicy(intent).allowed).toBe(true);
    }
  });
});
