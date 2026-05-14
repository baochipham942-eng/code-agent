import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { FeishuChannel } from '../../../src/main/channels/feishu/feishuChannel';
import type { ChannelMessage } from '../../../src/shared/contract/channel';

type FeishuChannelHarness = FeishuChannel & {
  handleMessageEvent(event: unknown): Promise<void>;
  webhookServer?: Server | null;
};

function createTextEvent(text: string): unknown {
  return {
    message: {
      message_id: 'om_realistic_1',
      root_id: '',
      parent_id: '',
      create_time: '1800000000000',
      chat_id: 'oc_realistic_chat',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      mentions: [{
        key: '@Aix',
        id: {
          open_id: 'ou_bot',
          user_id: 'bot_user',
        },
        name: 'Aix',
      }],
    },
    sender: {
      sender_id: {
        open_id: 'ou_sender',
        user_id: 'sender_user',
      },
      sender_type: 'user',
    },
  };
}

async function emitFeishuMessage(
  privacyMode: 'local-redact' | 'allow-raw' | 'off' | undefined,
  text: string,
): Promise<ChannelMessage> {
  const channel = new FeishuChannel('feishu-account');
  const emitted: ChannelMessage[] = [];
  channel.on('message', (message: ChannelMessage) => emitted.push(message));

  await channel.initialize({
    type: 'feishu',
    appId: 'cli_test',
    appSecret: 'app_secret_test',
    privacyMode,
  });

  await (channel as unknown as FeishuChannelHarness).handleMessageEvent(createTextEvent(text));
  await channel.destroy();

  expect(emitted).toHaveLength(1);
  return emitted[0];
}

async function postFeishuWebhook(text: string): Promise<{
  response: Response;
  message: ChannelMessage;
}> {
  const channel = new FeishuChannel('feishu-account');
  const emitted: ChannelMessage[] = [];
  channel.on('message', (message: ChannelMessage) => emitted.push(message));

  await channel.initialize({
    type: 'feishu',
    appId: 'cli_test',
    appSecret: 'app_secret_test',
    webhookHost: '127.0.0.1',
    webhookPort: 0,
    privacyMode: 'local-redact',
  });

  await channel.connect();

  try {
    const server = (channel as unknown as FeishuChannelHarness).webhookServer;
    const address = server?.address() as AddressInfo | null;
    expect(address?.port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${address!.port}/webhook/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_realistic_1',
          event_type: 'im.message.receive_v1',
        },
        event: createTextEvent(text),
      }),
    });

    expect(emitted).toHaveLength(1);
    return { response, message: emitted[0] };
  } finally {
    await channel.destroy();
  }
}

describe('Feishu channel privacy smoke', () => {
  it('redacts a realistic Feishu text event before emitting a ChannelMessage', async () => {
    const message = await emitFeishuMessage(
      'local-redact',
      'alice@example.com paid with 4242 4242 4242 4242',
    );
    const json = JSON.stringify(message);

    expect(message.content).toContain('[email hidden]');
    expect(message.content).toContain('[credit card hidden]');
    expect(message.raw).toBeDefined();
    expect(json).toContain('om_realistic_1');
    expect(json).not.toContain('alice@example.com');
    expect(json).not.toContain('4242 4242 4242 4242');
  });

  it('keeps raw Feishu payloads only when allow-raw is configured', async () => {
    const message = await emitFeishuMessage(
      'allow-raw',
      'alice@example.com paid with 4242 4242 4242 4242',
    );

    expect(message.content).toContain('[email hidden]');
    expect(JSON.stringify(message.raw)).toContain('alice@example.com');
  });

  it('redacts a Feishu schema 2.0 event received through the local webhook', async () => {
    const { response, message } = await postFeishuWebhook(
      'alice@example.com paid with 4242 4242 4242 4242',
    );
    const json = JSON.stringify(message);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 0, msg: 'success' });
    expect(message.content).toContain('[email hidden]');
    expect(message.content).toContain('[credit card hidden]');
    expect(json).toContain('om_realistic_1');
    expect(json).not.toContain('alice@example.com');
    expect(json).not.toContain('4242 4242 4242 4242');
  });
});
