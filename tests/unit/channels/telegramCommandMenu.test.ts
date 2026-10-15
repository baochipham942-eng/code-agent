import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getMe: vi.fn(async () => ({ id: 100, username: 'NeoBot', first_name: 'Neo' })),
  setMyCommands: vi.fn(async () => true),
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = api;
    on() {}
    catch() {}
    start() {}
  },
}));

import { TelegramChannel } from '../../../src/host/channels/telegram/telegramChannel';

async function connect(): Promise<TelegramChannel> {
  const channel = new TelegramChannel('telegram-1');
  await channel.initialize({ type: 'telegram', botToken: 'token' } as never);
  await channel.connect();
  return channel;
}

describe('Telegram command menu', () => {
  it('registers stop/new/status in English and Chinese on connect', async () => {
    await connect();
    const calls = api.setMyCommands.mock.calls as unknown as Array<[Array<{ command: string; description: string }>, { language_code?: string }?]>;
    expect(calls).toHaveLength(2);
    for (const [commands] of calls) expect(commands.map(c => c.command)).toEqual(['stop', 'new', 'status']);
    expect(calls.find(([, opts]) => opts?.language_code === 'zh')?.[0][0]?.description).toBe('停止正在运行的任务');
  });

  it('still connects when the command menu cannot be registered', async () => {
    api.setMyCommands.mockRejectedValueOnce(new Error('403'));
    const channel = await connect();
    expect(channel.status).not.toBe('error');
  });
});
