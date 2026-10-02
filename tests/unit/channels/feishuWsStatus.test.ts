import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';
import { FeishuChannel } from '../../../src/host/channels/feishu/feishuChannel';

type StatusEvent = { status: string; message?: string };

type WsHandlers = {
  onReady?: () => void;
  onError?: (err: Error) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
};

type WsCtorOpts = WsHandlers & {
  logger?: { info: (...args: unknown[]) => void };
  loggerLevel?: lark.LoggerLevel;
  autoReconnect?: boolean;
  appSecret?: string;
};

type WsStartOpts = WsHandlers & {
  eventDispatcher?: unknown;
};

const loggerSpies = vi.hoisted(() => ({ info: vi.fn() }));

const wsCaptures = vi.hoisted(() => ({
  ctor: [] as WsCtorOpts[],
  start: [] as WsStartOpts[],
}));

vi.mock('../../../src/host/services/infra/logger', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/infra/logger')>(
    '../../../src/host/services/infra/logger',
  );
  return {
    ...actual,
    createLogger: (context: string, options?: Parameters<typeof actual.createLogger>[1]) => {
      const created = actual.createLogger(context, options);
      if (context === 'FeishuChannel') {
        const originalInfo = created.info.bind(created);
        created.info = ((message: string, ...args: unknown[]) => {
          loggerSpies.info(message, ...args);
          originalInfo(message, ...args);
        }) as typeof created.info;
      }
      return created;
    },
  };
});

vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<typeof import('@larksuiteoapi/node-sdk')>(
    '@larksuiteoapi/node-sdk',
  );
  class WSClient {
    close = vi.fn();
    constructor(opts: WsCtorOpts) {
      wsCaptures.ctor.push(opts);
    }
    start = vi.fn((opts: WsStartOpts) => {
      wsCaptures.start.push(opts);
      return Promise.resolve();
    });
  }
  return { ...actual, WSClient };
});

const APP_SECRET = 'app-secret-test';
const HANDSHAKE_TIMEOUT_MS = 30_000;
const openChannels: FeishuChannel[] = [];

function watchStatus(channel: FeishuChannel): StatusEvent[] {
  const events: StatusEvent[] = [];
  channel.on('status_change', (status: string, message?: string) => {
    events.push({ status, message });
  });
  return events;
}

function latestClient(): { ctor: WsCtorOpts; start: WsStartOpts } {
  const ctor = wsCaptures.ctor.at(-1);
  const start = wsCaptures.start.at(-1);
  if (!ctor || !start) {
    throw new Error('WSClient was not constructed');
  }
  return { ctor, start };
}

async function openChannel(envDebug = false): Promise<FeishuChannel> {
  if (envDebug) process.env.NEO_FEISHU_WS_DEBUG = '1';
  else delete process.env.NEO_FEISHU_WS_DEBUG;
  const channel = new FeishuChannel('feishu-account');
  await channel.initialize({
    type: 'feishu',
    appId: 'cli_test',
    appSecret: APP_SECRET,
    verificationToken: 'verify-token-test',
    encryptKey: 'encrypt-key-test',
    useWebSocket: true,
  });
  openChannels.push(channel);
  vi.useFakeTimers();
  return channel;
}

afterEach(async () => {
  vi.useRealTimers();
  while (openChannels.length > 0) {
    const channel = openChannels.pop();
    await channel?.disconnect();
  }
  wsCaptures.ctor.length = 0;
  wsCaptures.start.length = 0;
  loggerSpies.info.mockClear();
  delete process.env.NEO_FEISHU_WS_DEBUG;
});

describe('Feishu WebSocket status', () => {
  it('④a stays unconnected and errors when the handshake times out', async () => {
    const channel = await openChannel();
    const events = watchStatus(channel);
    const pending = channel.connect();
    const settled = expect(pending).rejects.toThrow(/handshake timeout/);

    expect(wsCaptures.start).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    await settled;

    expect(channel.status).toBe('error');
    expect(events.map((event) => event.status)).not.toContain('connected');
    const errors = events.filter((event) => event.status === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/handshake timeout/);

    latestClient().ctor.onReady?.();
    expect(channel.status).toBe('connected');
  });

  it('④b records onError once with the SDK message', async () => {
    const channel = await openChannel();
    const events = watchStatus(channel);
    const pending = channel.connect();
    latestClient().ctor.onError?.(new Error('boom'));

    await expect(pending).rejects.toThrow(/boom/);
    expect(channel.status).toBe('error');
    const errors = events.filter((event) => event.status === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('boom');
  });

  it('④c follows onReady, onReconnecting, and onReconnected', async () => {
    const channel = await openChannel();
    const events = watchStatus(channel);
    const pending = channel.connect();
    await vi.advanceTimersByTimeAsync(0);
    const { ctor, start } = latestClient();

    expect(channel.status).toBe('connecting');
    expect(events.some((event) => event.status === 'connected')).toBe(false);
    expect(start.onReady).toBe(ctor.onReady);

    ctor.onReady?.();
    await pending;
    expect(channel.status).toBe('connected');

    ctor.onReconnecting?.();
    expect(channel.status).toBe('connecting');
    expect(events.at(-1)?.message).toBe('重连中');

    ctor.onReconnected?.();
    expect(channel.status).toBe('connected');
  });

  it('④d ignores a late onReady after disconnect', async () => {
    const channel = await openChannel();
    const pending = channel.connect().catch((error: unknown) => error);
    const { ctor } = latestClient();

    await channel.disconnect();
    ctor.onReady?.();

    expect(channel.status).toBe('disconnected');
    expect(await pending).toBeInstanceOf(Error);
    expect(channel.status).toBe('disconnected');
  });

  it('③ forwards SDK logs through Neo logger with the [lark-ws] prefix', async () => {
    const channel = await openChannel();
    const pending = channel.connect();
    const { ctor } = latestClient();

    expect(ctor.loggerLevel).toBe(lark.LoggerLevel.info);
    expect(ctor.autoReconnect).toBe(true);
    expect(ctor.logger).toBeTruthy();
    ctor.logger?.info('[ws]', 'endpoint reset');
    ctor.logger?.info('credential', APP_SECRET);

    const forwarded = loggerSpies.info.mock.calls.map((call) => String(call[0]));
    expect(forwarded.some((line) => line.startsWith('[lark-ws]'))).toBe(true);
    expect(forwarded.join('\n')).not.toContain(APP_SECRET);

    ctor.onReady?.();
    await pending;
    expect(channel.status).toBe('connected');
  });

  it('uses debug loggerLevel when NEO_FEISHU_WS_DEBUG=1', async () => {
    const channel = await openChannel(true);
    const pending = channel.connect();
    expect(latestClient().ctor.loggerLevel).toBe(lark.LoggerLevel.debug);
    latestClient().ctor.onReady?.();
    await pending;
  });
});
