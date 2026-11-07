// FB-477 regression: SSE dispatch spreads array args; the accounts listener must
// still end up with the full ChannelAccount[] (0 / 1 / 3 accounts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: { getState: () => ({ status: 'disconnected' }) },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({ invokeTool: vi.fn() }),
}));

(globalThis as Record<string, unknown>).window = { __CODE_AGENT_TOKEN__: undefined };

import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { normalizeChannelAccountsPayload } from '../../../src/renderer/components/features/settings/tabs/channelAccountsPayload';

interface FakeES {
  onmessage: ((e: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
}

describe('channel:accounts-changed over real SSE dispatch', () => {
  let instances: FakeES[];
  let original: unknown;

  beforeEach(() => {
    instances = [];
    original = (globalThis as Record<string, unknown>).EventSource;
    const ctor = function (this: FakeES) {
      this.onmessage = null;
      this.onerror = null;
      this.close = () => {};
      instances.push(this);
    } as unknown as { CLOSED: number };
    ctor.CLOSED = 2;
    (globalThis as Record<string, unknown>).EventSource = ctor;
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).EventSource = original;
  });

  const acc = (id: string) => ({ id, name: id, type: 'telegram', status: 'connected' });

  it.each([3, 1, 0])('listener state is an array of length %i', (n) => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');
    let state: unknown = [];
    // Same shape as the real listeners: (...args) => setAccounts(normalize(...args))
    api.on(IPC_CHANNELS.CHANNEL_ACCOUNTS_CHANGED, ((...args: unknown[]) => {
      state = normalizeChannelAccountsPayload(...args);
    }) as never);

    const list = Array.from({ length: n }, (_, i) => acc(`a${i}`));
    instances[0].onmessage!({ data: JSON.stringify({ channel: 'channel:accounts-changed', args: list }) });

    expect(Array.isArray(state)).toBe(true);
    expect(state).toHaveLength(n);
    expect(state).toEqual(list);
  });
});
