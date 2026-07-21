import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_RELAY_ACTION_METHODS_V2,
  BROWSER_RELAY_CAPABILITIES_V2,
  BROWSER_RELAY_PROTOCOL_VERSION_V2,
} from '../../../src/shared/contract/browserRelay';

const extensionRoot = path.join(process.cwd(), 'resources', 'browser-relay-extension');
const protocolSource = fs.readFileSync(path.join(extensionRoot, 'protocol-v2.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');

interface MockEvent<T extends (...args: never[]) => unknown> {
  addListener: (listener: T) => void;
  emit: (...args: Parameters<T>) => void;
  listeners: T[];
}

function mockEvent<T extends (...args: never[]) => unknown>(): MockEvent<T> {
  const listeners: T[] = [];
  return {
    listeners,
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 1_500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for Browser Relay worker state');
}

function containsNativeBrowserId(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsNativeBrowserId);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (
    ['tabId', 'windowId', 'nativeTabId', 'agentWindowId', 'placeholderTabId'].includes(key)
      || containsNativeBrowserId(nested)
  ));
}

function createHarness(initialSession: Record<string, unknown> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const sockets: FakeWebSocket[] = [];
  const sessionStore: Record<string, unknown> = { ...initialSession };
  const localStore: Record<string, unknown> = {};
  const tabs = new Map<number, Record<string, unknown>>([
    [7, {
      id: 7,
      windowId: 3,
      index: 0,
      pinned: true,
      active: true,
      title: 'Relay fixture',
      url: 'https://example.test/start?private=1',
    }],
  ]);
  const windows = new Map<number, Record<string, unknown>>([[3, { id: 3, focused: true }]]);
  const debuggerCommands: Array<{ target: unknown; method: string; params: unknown }> = [];
  const tabMoves: Array<{ tabId: number; move: Record<string, unknown> }> = [];
  const debuggerOnDetach = mockEvent<(...args: never[]) => unknown>();
  const debuggerOnEvent = mockEvent<(...args: never[]) => unknown>();
  const tabsOnRemoved = mockEvent<(...args: never[]) => unknown>();
  const alarmsOnAlarm = mockEvent<(...args: never[]) => unknown>();
  const storageOnChanged = mockEvent<(...args: never[]) => unknown>();
  const runtimeOnMessage = mockEvent<(...args: never[]) => unknown>();

  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
      sockets.push(this);
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    receive(message: Record<string, unknown>): void {
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    send(payload: string): void {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  const chrome = {
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
    alarms: {
      create: vi.fn(),
      onAlarm: alarmsOnAlarm,
    },
    storage: {
      session: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(
          keys.filter((key) => key in sessionStore).map((key) => [key, sessionStore[key]]),
        )),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(sessionStore, values)),
      },
      local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(
          keys.filter((key) => key in localStore).map((key) => [key, localStore[key]]),
        )),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(localStore, values)),
      },
      onChanged: storageOnChanged,
    },
    tabs: {
      query: vi.fn(async (query: Record<string, unknown>) => {
        if (Number.isInteger(query.windowId)) {
          return [...tabs.values()].filter((tab) => tab.windowId === query.windowId);
        }
        return [...tabs.values()].filter((tab) => tab.active === true).slice(0, 1);
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('No tab');
        return { ...tab };
      }),
      create: vi.fn(async (input: Record<string, unknown>) => {
        const tab = { id: 8, index: 1, pinned: false, active: false, ...input };
        tabs.set(8, tab);
        return { ...tab };
      }),
      update: vi.fn(async (tabId: number, update: Record<string, unknown>) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('No tab');
        Object.assign(tab, update);
        return { ...tab };
      }),
      move: vi.fn(async (tabId: number, move: Record<string, unknown>) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('No tab');
        Object.assign(tab, move);
        tabMoves.push({ tabId, move: { ...move } });
        return { ...tab };
      }),
      remove: vi.fn(async (tabId: number) => {
        tabs.delete(tabId);
      }),
      onRemoved: tabsOnRemoved,
    },
    windows: {
      get: vi.fn(async (windowId: number) => {
        const window = windows.get(windowId);
        if (!window) throw new Error('No window');
        return { ...window };
      }),
      create: vi.fn(async (input: Record<string, unknown>) => {
        const window = { id: 20, focused: Boolean(input.focused), type: input.type };
        windows.set(20, window);
        const tabId = Number(input.tabId);
        const tab = tabs.get(tabId);
        if (tab) Object.assign(tab, { windowId: 20, index: 0, active: true });
        return { ...window };
      }),
      update: vi.fn(async (windowId: number, update: Record<string, unknown>) => {
        const window = windows.get(windowId);
        if (!window) throw new Error('No window');
        Object.assign(window, update);
        return { ...window };
      }),
    },
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      getTargets: vi.fn(async () => [{ tabId: 7, attached: true }]),
      sendCommand: vi.fn(async (target: unknown, method: string, params: Record<string, unknown>) => {
        debuggerCommands.push({ target, method, params });
        if (method === 'Page.captureScreenshot') return { data: 'iVBORw0KGgoAAAANSUhEUg==' };
        if (method === 'Page.navigate') {
          const tab = tabs.get(7);
          if (tab) tab.url = params.url;
          return { frameId: 'native-frame' };
        }
        if (method === 'Page.getNavigationHistory') {
          return { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] };
        }
        if (method === 'Page.getLayoutMetrics') {
          return {
            cssVisualViewport: { clientWidth: 1200, clientHeight: 800 },
            cssContentSize: { width: 1200, height: 1600 },
          };
        }
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 51 };
        if (method === 'DOM.getOuterHTML') return { outerHTML: '<main><button>Submit</button></main>' };
        if (method === 'DOM.describeNode') {
          return {
            node: {
              backendNodeId: 501,
              frameId: 'native-frame',
              nodeName: 'INPUT',
              attributes: ['type', 'file'],
            },
          };
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'remote-file-input-object' } };
        }
        if (method === 'Runtime.callFunctionOn') {
          return { result: { value: { fileCount: 1, fileSize: 73 } } };
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } };
        }
        if (method === 'DOM.pushNodesByBackendIdsToFrontend') {
          return { nodeIds: (params.backendNodeIds as unknown[]).map(() => 51) };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [{
              backendDOMNodeId: 501,
              frameId: 'native-frame',
              role: { value: 'button' },
              name: { value: 'Submit' },
            }],
          };
        }
        if (method === 'Accessibility.queryAXTree') {
          return { nodes: [{ role: { value: 'button' }, name: { value: 'Submit' } }] };
        }
        if (method === 'DOMSnapshot.captureSnapshot') {
          return { documents: [{ frameId: 'native-frame', nodes: { backendNodeId: [501] } }] };
        }
        return {};
      }),
      onDetach: debuggerOnDetach,
      onEvent: debuggerOnEvent,
    },
    runtime: {
      getPlatformInfo: vi.fn(async () => ({ os: 'mac' })),
      onMessage: runtimeOnMessage,
    },
  };

  const context = vm.createContext({
    AbortController,
    URL,
    chrome,
    console: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
    crypto: {
      randomUUID,
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    },
    fetch: vi.fn(async () => ({
      ok: true,
      json: async () => ({ port: 23001, token: 'memory-only-pairing-token' }),
    })),
    WebSocket: FakeWebSocket,
    setTimeout,
    clearTimeout,
    structuredClone,
    importScripts: vi.fn(),
  });
  vm.runInContext(protocolSource, context);
  vm.runInContext(workerSource, context);

  async function runtimeMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const listener = runtimeOnMessage.listeners[0] as unknown as (
      value: Record<string, unknown>,
      sender: unknown,
      respond: (value: Record<string, unknown>) => void,
    ) => boolean;
    return await new Promise((resolve, reject) => {
      if (!listener) {
        reject(new Error('Runtime listener is not installed'));
        return;
      }
      const keepChannel = listener(message, {}, resolve);
      if (keepChannel !== true) reject(new Error('Runtime listener closed the response channel'));
    });
  }

  return {
    alarmsOnAlarm,
    chrome,
    debuggerCommands,
    debuggerOnEvent,
    localStore,
    runtimeMessage,
    sent,
    sessionStore,
    sockets,
    tabMoves,
    tabs,
  };
}

const owner = {
  surfaceSessionId: 'surface-session-1',
  conversationId: 'conversation-1',
  runId: 'run-1',
  agentId: 'agent-1',
};

async function connectHarness(harness: ReturnType<typeof createHarness>) {
  const socket = await waitFor(() => harness.sockets[0]);
  socket.open();
  const hello = await waitFor(() => harness.sent.find((message) => message.type === 'hello'));
  expect(hello).toMatchObject({
    type: 'hello',
    protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
    capabilities: [...BROWSER_RELAY_CAPABILITIES_V2],
  });
  socket.receive({
    type: 'hello_ack',
    protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
    connectionGeneration: 'connection-generation-1',
    requiredCapabilities: [...BROWSER_RELAY_CAPABILITIES_V2],
  });
  return socket;
}

async function approveLease(
  harness: ReturnType<typeof createHarness>,
  socket: Awaited<ReturnType<typeof connectHarness>>,
  ttlMs = 60_000,
) {
  const actionScopes = [...Object.keys(BROWSER_RELAY_ACTION_METHODS_V2), 'close', 'lease:return'];
  socket.receive({
    type: 'lease.request',
    protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
    requestId: 'request-1',
    ...owner,
    domainScopes: ['selected-tab-origin'],
    actionScopes,
    consentDeadlineAt: Date.now() + Math.min(ttlMs, 30_000),
    expiresAt: Date.now() + ttlMs,
  });
  await waitFor(() => {
    const pending = harness.sessionStore.browserRelayPendingLeaseV2 as Record<string, unknown> | undefined;
    return pending?.requestId === 'request-1' ? pending : undefined;
  });
  const popupResult = await harness.runtimeMessage({ type: 'approvePendingLease' });
  expect(popupResult).toMatchObject({ ok: true });
  const approval = await waitFor(() => harness.sent.find((message) => message.type === 'lease.approved'));
  expect(approval).toMatchObject({
    type: 'lease.approved',
    requestId: 'request-1',
    ...owner,
    domainScopes: ['origin:https://example.test'],
    actionScopes,
  });
  expect(approval).not.toHaveProperty('lease');
  expect(approval.placement).toMatchObject({ origin: 'https://example.test' });
  return approval.leaseId as string;
}

async function firstDomTargetRef(
  harness: ReturnType<typeof createHarness>,
  socket: Awaited<ReturnType<typeof connectHarness>>,
  leaseId: string,
  label: string,
) {
  const id = `${label}-dom`;
  socket.receive({
    type: 'command',
    protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
    id,
    operationId: `${label}-dom-operation`,
    leaseId,
    ...owner,
    method: BROWSER_RELAY_ACTION_METHODS_V2.get_dom_snapshot,
    actionScope: 'get_dom_snapshot',
    deadlineAt: Date.now() + 2_000,
    params: {},
  });
  const snapshot = await waitFor(() => harness.sent.find((message) => message.id === id));
  return (snapshot.result as { elements: Array<{ ref: string }> }).elements[0];
}

describe('Browser Relay extension protocol v2 worker', () => {
  it('requests the current document before resolving AX backend nodes in every command', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    let operation = 0;

    for (const actionScope of ['get_dom_snapshot', 'get_a11y_snapshot', 'click_text'] as const) {
      const id = `command-document-${++operation}`;
      socket.receive({
        type: 'command',
        protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
        id,
        operationId: `operation-document-${operation}`,
        leaseId,
        ...owner,
        method: BROWSER_RELAY_ACTION_METHODS_V2[actionScope],
        actionScope,
        deadlineAt: Date.now() + 2_000,
        params: actionScope === 'click_text' ? { text: 'Submit' } : {},
      });
      const response = await waitFor(() => harness.sent.find((message) => (
        message.type === 'response' && message.id === id
      )));
      expect(response.error).toBeUndefined();
    }

    const methods = harness.debuggerCommands.map((command) => command.method);
    let previousPush = -1;
    for (const [index, method] of methods.entries()) {
      if (method !== 'DOM.pushNodesByBackendIdsToFrontend') continue;
      expect(methods.slice(previousPush + 1, index)).toContain('DOM.getDocument');
      previousPush = index;
    }
    expect(previousPush).toBeGreaterThan(-1);
  });

  it('executes the canonical catalog, cancels in flight work, and returns the approved tab', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    let operation = 0;

    const execute = async (actionScope: keyof typeof BROWSER_RELAY_ACTION_METHODS_V2, params: Record<string, unknown> = {}) => {
      const id = `command-${++operation}`;
      socket.receive({
        type: 'command',
        protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
        id,
        operationId: `operation-${operation}`,
        leaseId,
        ...owner,
        method: BROWSER_RELAY_ACTION_METHODS_V2[actionScope],
        actionScope,
        deadlineAt: Date.now() + 2_000,
        params,
      });
      const response = await waitFor(() => harness.sent.find((message) => message.type === 'response' && message.id === id));
      expect(response.error).toBeUndefined();
      expect(containsNativeBrowserId(response)).toBe(false);
      return response;
    };

    const parameters: Partial<Record<keyof typeof BROWSER_RELAY_ACTION_METHODS_V2, Record<string, unknown>>> = {
      navigate: { url: 'https://example.test/next' },
      click: { selector: 'button' },
      click_text: { text: 'Submit' },
      type: { selector: 'button', text: 'hello' },
      press_key: { key: 'Meta+A' },
      scroll: { direction: 'down', amount: 240 },
      handle_dialog: { dialogAction: 'dismiss' },
      screenshot: { format: 'png', fullPage: true },
      get_dom_snapshot: { computedStyles: ['display'] },
      wait: { timeoutMs: 1 },
      get_logs: { afterCursor: 0 },
    };

    for (const action of Object.keys(BROWSER_RELAY_ACTION_METHODS_V2) as Array<keyof typeof BROWSER_RELAY_ACTION_METHODS_V2>) {
      let actionParams = parameters[action];
      if (action === 'hover' || action === 'drag' || action === 'upload_file') {
        const snapshot = await execute('get_dom_snapshot');
        const element = (snapshot.result as { elements: Array<{ ref: string }> }).elements[0];
        actionParams = action === 'drag'
          ? {
              targetRef: { ref: element.ref },
              destinationTargetRef: { ref: element.ref },
            }
          : action === 'upload_file'
            ? {
                targetRef: { ref: element.ref },
                uploadApprovalRef: 'upload-approval-opaque',
                uploadFilePath: '/private/tmp/surface-secret-canary-upload-path.txt',
              }
            : { targetRef: { ref: element.ref } };
      }
      if (action === 'handle_dialog') {
        harness.debuggerOnEvent.emit(
          { tabId: 7 } as never,
          'Page.javascriptDialogOpening' as never,
          {
            type: 'confirm',
            message: 'surface-secret-canary-dialog',
          } as never,
        );
      }
      if (action === 'get_logs') {
        harness.debuggerOnEvent.emit(
          { tabId: 7 } as never,
          'Runtime.consoleAPICalled' as never,
          {
            type: 'log',
            args: [{ value: 'Authorization: Bearer canary-secret' }],
            timestamp: Date.now(),
          } as never,
        );
        harness.debuggerOnEvent.emit(
          { tabId: 7 } as never,
          'Network.requestWillBeSent' as never,
          {
            request: {
              method: 'POST',
              url: 'https://example.test/api/commit?token=surface-secret-canary-network',
              headers: { Authorization: 'Bearer surface-secret-canary-network' },
              postData: 'password=surface-secret-canary-network',
            },
            timestamp: Date.now(),
          } as never,
        );
        harness.debuggerOnEvent.emit(
          { tabId: 7 } as never,
          'Network.responseReceived' as never,
          {
            response: {
              status: 201,
              mimeType: 'application/json',
              url: 'https://example.test/api/commit?token=surface-secret-canary-network',
              headers: { 'set-cookie': 'session=surface-secret-canary-network' },
            },
            timestamp: Date.now(),
          } as never,
        );
      }
      const response = await execute(action, actionParams);
      if (action === 'screenshot') {
        expect(response.result).toMatchObject({
          imageBase64: 'iVBORw0KGgoAAAANSUhEUg==',
          imageMimeType: 'image/png',
          fullPage: true,
        });
      }
      if (action === 'get_dom_snapshot' || action === 'get_a11y_snapshot') {
        expect(response.result).toMatchObject({
          elements: [expect.objectContaining({ backendNodeId: 501, role: 'button', name: 'Submit' })],
        });
      }
      if (action === 'get_logs') {
        expect(JSON.stringify(response.result)).not.toContain('canary-secret');
        expect(JSON.stringify(response.result)).not.toContain('surface-secret-canary-network');
        expect(JSON.stringify(response.result)).toContain('[REDACTED]');
        expect(response.result).toMatchObject({
          entries: expect.arrayContaining([
            expect.objectContaining({
              source: 'network',
              text: 'request POST',
              url: 'https://example.test/api/commit',
            }),
            expect.objectContaining({
              source: 'network',
              text: 'response 201 application/json',
              url: 'https://example.test/api/commit',
            }),
          ]),
        });
      }
      if (action === 'handle_dialog') {
        expect(JSON.stringify(response.result)).not.toContain('surface-secret-canary-dialog');
        expect(response.result).toMatchObject({ handled: true, action: 'dismiss', type: 'confirm' });
      }
      if (action === 'upload_file') {
        expect(response.result).toMatchObject({ fileAssigned: true, fileCount: 1, fileSize: 73 });
        expect(JSON.stringify(response)).not.toContain('/private/tmp/');
        expect(JSON.stringify(response)).not.toContain('surface-secret-canary-upload-path');
      }
    }

    const cancelledId = 'command-cancelled';
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: cancelledId,
      operationId: 'operation-cancelled',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.wait,
      actionScope: 'wait',
      deadlineAt: Date.now() + 2_000,
      params: { timeoutMs: 1_000 },
    });
    socket.receive({
      type: 'cancel',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      operationId: 'operation-cancelled',
      leaseId,
      ...owner,
      reason: 'test-cancel',
    });
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'command-return',
      operationId: 'operation-return',
      leaseId,
      ...owner,
      method: 'lease.return',
      actionScope: 'lease:return',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const cancelled = await waitFor(() => harness.sent.find((message) => message.type === 'response' && message.id === cancelledId));
    expect(cancelled.error).toMatchObject({
      code: 'RELAY_OPERATION_CANCELLED',
      delivery: 'not_attempted',
    });
    expect(harness.sent.some((message) => message.type === 'cancel.ack')).toBe(false);
    const returned = await waitFor(() => harness.sent.find((message) => message.type === 'lease.returned'));
    expect(returned).toMatchObject({ type: 'lease.returned', leaseId, ...owner });
    await waitFor(() => harness.sent.find((message) => message.type === 'response' && message.id === 'command-return'));
    expect(harness.tabMoves.at(-1)).toEqual({ tabId: 7, move: { windowId: 3, index: 0 } });
    expect(harness.tabs.get(7)).toMatchObject({ windowId: 3, index: 0, pinned: true, active: true });

    for (const message of harness.sent) expect(containsNativeBrowserId(message)).toBe(false);
    expect(harness.chrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(harness.debuggerCommands.some((command) => command.method === 'Input.dispatchMouseEvent')).toBe(true);
    expect(harness.debuggerCommands.some((command) => command.method === 'Input.dispatchKeyEvent')).toBe(true);
    expect(harness.debuggerCommands.some((command) => command.method === 'Network.enable')).toBe(true);
    expect(harness.debuggerCommands).toContainEqual(expect.objectContaining({
      method: 'Page.captureScreenshot',
      params: expect.objectContaining({
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1200, height: 1600, scale: 1 },
      }),
    }));
    expect(harness.debuggerCommands).toContainEqual(expect.objectContaining({
      method: 'DOM.setFileInputFiles',
      params: {
        files: ['/private/tmp/surface-secret-canary-upload-path.txt'],
        backendNodeId: 501,
      },
    }));
    expect(harness.debuggerCommands).toContainEqual(expect.objectContaining({
      method: 'Runtime.callFunctionOn',
      params: expect.objectContaining({
        objectId: 'remote-file-input-object',
        returnByValue: true,
      }),
    }));
  });

  it('does not start a full-page capture after cancellation arrives during layout metrics', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');

    let releaseMetrics: (() => void) | undefined;
    let notifyMetricsStarted: (() => void) | undefined;
    const metricsGate = new Promise<void>((resolve) => { releaseMetrics = resolve; });
    const metricsStarted = new Promise<void>((resolve) => { notifyMetricsStarted = resolve; });
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await originalSendCommand?.(target, method, params);
      if (method === 'Page.getLayoutMetrics') {
        notifyMetricsStarted?.();
        await metricsGate;
      }
      return result;
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'full-page-cancelled',
      operationId: 'full-page-cancelled-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.screenshot,
      actionScope: 'screenshot',
      deadlineAt: Date.now() + 2_000,
      params: { format: 'png', fullPage: true },
    });
    await metricsStarted;
    socket.receive({
      type: 'cancel',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      operationId: 'full-page-cancelled-operation',
      leaseId,
      ...owner,
      reason: 'user-stop',
    });
    releaseMetrics?.();

    const response = await waitFor(() => harness.sent.find((message) => (
      message.id === 'full-page-cancelled'
    )));
    expect(response.error).toMatchObject({
      code: 'RELAY_OPERATION_CANCELLED',
      delivery: 'not_attempted',
    });
    expect(harness.debuggerCommands.some((command) => (
      command.method === 'Page.captureScreenshot'
    ))).toBe(false);
  });

  it('fails closed without returning held page content after a cross-origin navigation', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');

    let releaseOuterHtml: (() => void) | undefined;
    let notifyOuterHtmlStarted: (() => void) | undefined;
    const outerHtmlGate = new Promise<void>((resolve) => { releaseOuterHtml = resolve; });
    const outerHtmlStarted = new Promise<void>((resolve) => { notifyOuterHtmlStarted = resolve; });
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await originalSendCommand?.(target, method, params);
      if (method !== 'DOM.getOuterHTML') return result;
      notifyOuterHtmlStarted?.();
      await outerHtmlGate;
      return { outerHTML: '<main>surface-secret-canary-forbidden-origin</main>' };
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'cross-origin-held-read',
      operationId: 'cross-origin-held-read-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_content,
      actionScope: 'get_content',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    await outerHtmlStarted;

    const tab = harness.tabs.get(7);
    expect(tab).toBeDefined();
    if (tab) tab.url = 'https://forbidden.test/private?token=surface-secret-canary-forbidden-origin';
    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Page.frameNavigated' as never,
      {
        frame: {
          id: 'native-frame',
          url: 'https://forbidden.test/private?token=surface-secret-canary-forbidden-origin',
        },
      } as never,
    );
    releaseOuterHtml?.();

    const response = await waitFor(() => harness.sent.find((message) => (
      message.id === 'cross-origin-held-read'
    )));
    expect(response.result).toBeUndefined();
    expect(response.error).toMatchObject({
      code: 'RELAY_DOMAIN_NOT_ALLOWED',
      delivery: 'not_attempted',
    });
    expect(JSON.stringify(response)).not.toContain('forbidden.test');
    expect(JSON.stringify(response)).not.toContain('surface-secret-canary-forbidden-origin');
  });

  it('does not leak an out-of-scope CDP rejection after navigation aborts a read', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');

    let releaseOuterHtml: (() => void) | undefined;
    let notifyOuterHtmlStarted: (() => void) | undefined;
    const outerHtmlGate = new Promise<void>((resolve) => { releaseOuterHtml = resolve; });
    const outerHtmlStarted = new Promise<void>((resolve) => { notifyOuterHtmlStarted = resolve; });
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await originalSendCommand?.(target, method, params);
      if (method !== 'DOM.getOuterHTML') return result;
      notifyOuterHtmlStarted?.();
      await outerHtmlGate;
      throw new Error('https://forbidden.test/surface-secret-canary-cdp-rejection');
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'cross-origin-held-read-rejection',
      operationId: 'cross-origin-held-read-rejection-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_content,
      actionScope: 'get_content',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    await outerHtmlStarted;

    const tab = harness.tabs.get(7);
    expect(tab).toBeDefined();
    if (tab) tab.url = 'https://forbidden.test/private';
    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Page.frameNavigated' as never,
      { frame: { id: 'native-frame', url: 'https://forbidden.test/private' } } as never,
    );
    releaseOuterHtml?.();

    const response = await waitFor(() => harness.sent.find((message) => (
      message.id === 'cross-origin-held-read-rejection'
    )));
    expect(response.error).toMatchObject({
      code: 'RELAY_DOMAIN_NOT_ALLOWED',
      delivery: 'not_attempted',
    });
    expect(JSON.stringify(response)).not.toContain('forbidden.test');
    expect(JSON.stringify(response)).not.toContain('surface-secret-canary-cdp-rejection');
  });

  it('does not issue more input after a cross-origin navigation interrupts a held mutation', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const targetRef = await firstDomTargetRef(harness, socket, leaseId, 'cross-origin-held-mutation');
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');

    let releaseFocus: (() => void) | undefined;
    let notifyFocusStarted: (() => void) | undefined;
    const focusGate = new Promise<void>((resolve) => { releaseFocus = resolve; });
    const focusStarted = new Promise<void>((resolve) => { notifyFocusStarted = resolve; });
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await originalSendCommand?.(target, method, params);
      if (method === 'DOM.focus') {
        notifyFocusStarted?.();
        await focusGate;
      }
      return result;
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'cross-origin-held-mutation',
      operationId: 'cross-origin-held-mutation-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.type,
      actionScope: 'type',
      deadlineAt: Date.now() + 2_000,
      params: { targetRef, text: 'must-not-be-delivered' },
    });
    await focusStarted;

    const tab = harness.tabs.get(7);
    expect(tab).toBeDefined();
    if (tab) tab.url = 'https://forbidden.test/private';
    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Page.frameNavigated' as never,
      { frame: { id: 'native-frame', url: 'https://forbidden.test/private' } } as never,
    );
    releaseFocus?.();

    const response = await waitFor(() => harness.sent.find((message) => (
      message.id === 'cross-origin-held-mutation'
    )));
    expect(response.error).toMatchObject({
      code: 'RELAY_DOMAIN_NOT_ALLOWED',
      delivery: 'unknown',
    });
    expect(harness.debuggerCommands.some((command) => (
      command.method === 'Input.dispatchKeyEvent' || command.method === 'Input.insertText'
    ))).toBe(false);
  });

  it('does not release or continue a held drag after its document crosses origin', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const targetRef = await firstDomTargetRef(harness, socket, leaseId, 'cross-origin-held-drag');
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');

    let releasePressed: (() => void) | undefined;
    let notifyPressed: (() => void) | undefined;
    const pressedGate = new Promise<void>((resolve) => { releasePressed = resolve; });
    const pressed = new Promise<void>((resolve) => { notifyPressed = resolve; });
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await originalSendCommand?.(target, method, params);
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        notifyPressed?.();
        await pressedGate;
      }
      return result;
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'cross-origin-held-drag',
      operationId: 'cross-origin-held-drag-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.drag,
      actionScope: 'drag',
      deadlineAt: Date.now() + 2_000,
      params: { targetRef, destinationTargetRef: targetRef },
    });
    await pressed;

    const tab = harness.tabs.get(7);
    expect(tab).toBeDefined();
    if (tab) tab.url = 'https://forbidden.test/private';
    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Page.frameNavigated' as never,
      { frame: { id: 'native-frame', url: 'https://forbidden.test/private' } } as never,
    );
    releasePressed?.();

    const response = await waitFor(() => harness.sent.find((message) => (
      message.id === 'cross-origin-held-drag'
    )));
    expect(response.error).toMatchObject({
      code: 'RELAY_DOMAIN_NOT_ALLOWED',
      delivery: 'unknown',
    });
    expect(harness.debuggerCommands.filter((command) => (
      command.method === 'Input.dispatchMouseEvent'
    )).map((command) => (command.params as { type?: string }).type)).toEqual([
      'mouseMoved',
      'mousePressed',
    ]);
  });

  it('refreshes document revision and stale refs without blocking same-origin navigation', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'same-origin-before',
      operationId: 'same-origin-before-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_dom_snapshot,
      actionScope: 'get_dom_snapshot',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const before = await waitFor(() => harness.sent.find((message) => (
      message.id === 'same-origin-before'
    )));
    expect(before.error).toBeUndefined();
    const priorRevision = (before.result as {
      target: { documentRevision: string };
    }).target.documentRevision;
    const staleTargetRef = (before.result as {
      elements: Array<{ ref: string }>;
    }).elements[0];

    const tab = harness.tabs.get(7);
    expect(tab).toBeDefined();
    if (tab) tab.url = 'https://example.test/next?private=2';
    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Page.frameNavigated' as never,
      { frame: { id: 'native-frame-next', url: 'https://example.test/next?private=2' } } as never,
    );

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'same-origin-stale-ref',
      operationId: 'same-origin-stale-ref-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.click,
      actionScope: 'click',
      deadlineAt: Date.now() + 2_000,
      params: { targetRef: staleTargetRef },
    });
    const stale = await waitFor(() => harness.sent.find((message) => (
      message.id === 'same-origin-stale-ref'
    )));
    expect(stale.error).toMatchObject({
      code: 'RELAY_TARGET_CHANGED',
      delivery: 'not_attempted',
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'same-origin-after',
      operationId: 'same-origin-after-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_dom_snapshot,
      actionScope: 'get_dom_snapshot',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const after = await waitFor(() => harness.sent.find((message) => (
      message.id === 'same-origin-after'
    )));
    expect(after.error).toBeUndefined();
    expect((after.result as {
      target: { documentRevision: string };
    }).target.documentRevision).not.toBe(priorRevision);
    expect(harness.debuggerCommands.some((command) => (
      command.method === 'Input.dispatchMouseEvent'
    ))).toBe(false);
  });

  it('drops console and network metadata observed while the leased document is out of scope', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const tab = harness.tabs.get(7);
    expect(tab).toBeDefined();

    if (tab) tab.url = 'https://forbidden.test/private';
    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Page.frameNavigated' as never,
      { frame: { id: 'native-frame', url: 'https://forbidden.test/private' } } as never,
    );
    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Runtime.consoleAPICalled' as never,
      {
        type: 'log',
        args: [{ value: 'surface-secret-canary-out-of-scope-console' }],
        timestamp: Date.now(),
      } as never,
    );
    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Network.requestWillBeSent' as never,
      {
        request: {
          method: 'POST',
          url: 'https://forbidden.test/api?token=surface-secret-canary-out-of-scope-network',
        },
        timestamp: Date.now(),
      } as never,
    );

    if (tab) tab.url = 'https://example.test/returned';
    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Page.frameNavigated' as never,
      { frame: { id: 'native-frame-returned', url: 'https://example.test/returned' } } as never,
    );
    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Runtime.consoleAPICalled' as never,
      {
        type: 'log',
        args: [{ value: 'allowed-after-return' }],
        timestamp: Date.now(),
      } as never,
    );

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'out-of-scope-logs',
      operationId: 'out-of-scope-logs-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_logs,
      actionScope: 'get_logs',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const response = await waitFor(() => harness.sent.find((message) => (
      message.id === 'out-of-scope-logs'
    )));
    expect(response.error).toBeUndefined();
    expect(JSON.stringify(response.result)).toContain('allowed-after-return');
    expect(JSON.stringify(response.result)).not.toContain('forbidden.test');
    expect(JSON.stringify(response.result)).not.toContain('surface-secret-canary-out-of-scope');
  });

  it('pauses dialogs by default, exposes only safe metadata, and blocks stale retries', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const canary = 'surface-secret-canary-dialog-message';

    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Page.javascriptDialogOpening' as never,
      { type: 'prompt', message: canary } as never,
    );
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'dialog-state',
      operationId: 'dialog-state-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_dialog_state,
      actionScope: 'get_dialog_state',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const state = await waitFor(() => harness.sent.find((message) => message.id === 'dialog-state'));
    expect(state.error).toBeUndefined();
    expect(state.result).toMatchObject({
      pending: true,
      type: 'prompt',
      messageLength: canary.length,
      defaultPolicy: 'pause',
    });
    expect(JSON.stringify(state)).not.toContain(canary);
    expect(harness.debuggerCommands.some((command) => command.method === 'Page.handleJavaScriptDialog')).toBe(false);

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'dialog-dismiss',
      operationId: 'dialog-dismiss-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.handle_dialog,
      actionScope: 'handle_dialog',
      deadlineAt: Date.now() + 2_000,
      params: { dialogAction: 'dismiss' },
    });
    const dismissed = await waitFor(() => harness.sent.find((message) => message.id === 'dialog-dismiss'));
    expect(dismissed.error).toBeUndefined();
    expect(dismissed.result).toMatchObject({ handled: true, action: 'dismiss', type: 'prompt' });
    expect(harness.debuggerCommands).toContainEqual(expect.objectContaining({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: false },
    }));

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'dialog-stale-retry',
      operationId: 'dialog-stale-retry-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.handle_dialog,
      actionScope: 'handle_dialog',
      deadlineAt: Date.now() + 2_000,
      params: { dialogAction: 'dismiss' },
    });
    const staleRetry = await waitFor(() => harness.sent.find((message) => message.id === 'dialog-stale-retry'));
    expect(staleRetry.error).toMatchObject({
      code: 'RELAY_DIALOG_BLOCKED',
      delivery: 'not_attempted',
    });
  });

  it('allows only dialog recovery commands while a synchronous click is paused', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');

    let releasePausedClick: (() => void) | undefined;
    let notifyDialogOpened: (() => void) | undefined;
    const pausedClick = new Promise<void>((resolve) => { releasePausedClick = resolve; });
    const dialogOpened = new Promise<void>((resolve) => { notifyDialogOpened = resolve; });
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await originalSendCommand?.(target, method, params);
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        harness.debuggerOnEvent.emit(
          { tabId: 7 } as never,
          'Page.javascriptDialogOpening' as never,
          { type: 'confirm', message: 'surface-secret-canary-paused-click' } as never,
        );
        notifyDialogOpened?.();
        await pausedClick;
      }
      if (method === 'Page.handleJavaScriptDialog') releasePausedClick?.();
      return result;
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'paused-click-dom',
      operationId: 'paused-click-dom-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_dom_snapshot,
      actionScope: 'get_dom_snapshot',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const snapshot = await waitFor(() => harness.sent.find((message) => message.id === 'paused-click-dom'));
    const targetRef = (snapshot.result as { elements: Array<{ ref: string }> }).elements[0];

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'paused-click',
      operationId: 'paused-click-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.click,
      actionScope: 'click',
      deadlineAt: Date.now() + 2_000,
      params: { targetRef },
    });
    await dialogOpened;
    const clickBeforeHandle = await waitFor(() => (
      harness.sent.find((message) => message.id === 'paused-click')
    ));
    expect(clickBeforeHandle.error).toBeUndefined();
    expect(clickBeforeHandle.result).toMatchObject({
      clicked: true,
      pending: true,
      type: 'confirm',
      messageLength: 'surface-secret-canary-paused-click'.length,
      defaultPolicy: 'pause',
    });
    expect(JSON.stringify(clickBeforeHandle)).not.toContain('surface-secret-canary-paused-click');

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'paused-click-content',
      operationId: 'paused-click-content-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_content,
      actionScope: 'get_content',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const blockedContent = await waitFor(() => (
      harness.sent.find((message) => message.id === 'paused-click-content')
    ));
    expect(blockedContent.error).toMatchObject({
      code: 'RELAY_DIALOG_BLOCKED',
      message: 'A browser dialog is paused; only dialog state or handling is allowed',
      retryable: true,
      delivery: 'not_attempted',
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'paused-click-dialog-state',
      operationId: 'paused-click-dialog-state-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_dialog_state,
      actionScope: 'get_dialog_state',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const dialogState = await waitFor(() => (
      harness.sent.find((message) => message.id === 'paused-click-dialog-state')
    ));
    expect(dialogState.error).toBeUndefined();
    expect(dialogState.result).toMatchObject({
      pending: true,
      type: 'confirm',
      defaultPolicy: 'pause',
    });
    expect(JSON.stringify(dialogState)).not.toContain('surface-secret-canary-paused-click');

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'paused-click-dialog-handle',
      operationId: 'paused-click-dialog-handle-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.handle_dialog,
      actionScope: 'handle_dialog',
      deadlineAt: Date.now() + 2_000,
      params: { dialogAction: 'accept' },
    });
    const handled = await waitFor(() => (
      harness.sent.find((message) => message.id === 'paused-click-dialog-handle')
    ));
    expect(handled.error).toBeUndefined();
    expect(handled.result).toMatchObject({ handled: true, action: 'accept', type: 'confirm' });

    expect(harness.sent.filter((message) => message.id === 'paused-click')).toHaveLength(1);
  });

  it('detects a synchronous dialog raised by mousePressed before waiting for mouseReleased', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const targetRef = await firstDomTargetRef(harness, socket, leaseId, 'mousedown-dialog');
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');

    let releasePressed: (() => void) | undefined;
    let notifyDialogOpened: (() => void) | undefined;
    const pressed = new Promise<void>((resolve) => { releasePressed = resolve; });
    const dialogOpened = new Promise<void>((resolve) => { notifyDialogOpened = resolve; });
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await originalSendCommand?.(target, method, params);
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        harness.debuggerOnEvent.emit(
          { tabId: 7 } as never,
          'Page.javascriptDialogOpening' as never,
          { type: 'confirm', message: 'surface-secret-canary-mousedown-dialog' } as never,
        );
        notifyDialogOpened?.();
        await pressed;
      }
      if (method === 'Page.handleJavaScriptDialog') releasePressed?.();
      return result;
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'mousedown-dialog-click',
      operationId: 'mousedown-dialog-click-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.click,
      actionScope: 'click',
      deadlineAt: Date.now() + 2_000,
      params: { targetRef },
    });
    await dialogOpened;
    const click = await waitFor(() => harness.sent.find((message) => (
      message.id === 'mousedown-dialog-click'
    )));
    expect(click.error).toBeUndefined();
    expect(click.result).toMatchObject({
      clicked: true,
      pending: true,
      type: 'confirm',
      messageLength: 'surface-secret-canary-mousedown-dialog'.length,
      defaultPolicy: 'pause',
    });
    expect(JSON.stringify(click)).not.toContain('surface-secret-canary-mousedown-dialog');

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'mousedown-dialog-handle',
      operationId: 'mousedown-dialog-handle-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.handle_dialog,
      actionScope: 'handle_dialog',
      deadlineAt: Date.now() + 2_000,
      params: { dialogAction: 'dismiss' },
    });
    await waitFor(() => harness.sent.find((message) => message.id === 'mousedown-dialog-handle'));
    expect(harness.sent.filter((message) => message.id === 'mousedown-dialog-click')).toHaveLength(1);
    expect(harness.debuggerCommands.filter((command) => (
      command.method === 'Input.dispatchMouseEvent'
    )).map((command) => (command.params as { type?: string }).type)).toEqual(['mousePressed']);
  });

  it('keeps a newer chained dialog while allowing a different dialog generation to be handled', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');

    let handleCalls = 0;
    let releaseFirstHandle: (() => void) | undefined;
    let releaseSecondHandle: (() => void) | undefined;
    let notifySecondOpened: (() => void) | undefined;
    let notifySecondStarted: (() => void) | undefined;
    const firstHandleGate = new Promise<void>((resolve) => { releaseFirstHandle = resolve; });
    const secondHandleGate = new Promise<void>((resolve) => { releaseSecondHandle = resolve; });
    const secondOpened = new Promise<void>((resolve) => { notifySecondOpened = resolve; });
    const secondStarted = new Promise<void>((resolve) => { notifySecondStarted = resolve; });
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      if (method !== 'Page.handleJavaScriptDialog') {
        return await originalSendCommand?.(target, method, params);
      }
      handleCalls += 1;
      if (handleCalls === 1) {
        const result = await originalSendCommand?.(target, method, params);
        harness.debuggerOnEvent.emit(
          { tabId: 7 } as never,
          'Page.javascriptDialogOpening' as never,
          { type: 'alert', message: 'surface-secret-canary-chained-second' } as never,
        );
        notifySecondOpened?.();
        await firstHandleGate;
        return result;
      }
      notifySecondStarted?.();
      await secondHandleGate;
      return await originalSendCommand?.(target, method, params);
    });

    harness.debuggerOnEvent.emit(
      { tabId: 7 } as never,
      'Page.javascriptDialogOpening' as never,
      { type: 'confirm', message: 'surface-secret-canary-chained-first' } as never,
    );
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'chained-dialog-first',
      operationId: 'chained-dialog-first-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.handle_dialog,
      actionScope: 'handle_dialog',
      deadlineAt: Date.now() + 2_000,
      params: { dialogAction: 'accept' },
    });
    await secondOpened;

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'chained-dialog-second',
      operationId: 'chained-dialog-second-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.handle_dialog,
      actionScope: 'handle_dialog',
      deadlineAt: Date.now() + 2_000,
      params: { dialogAction: 'dismiss' },
    });
    await secondStarted;
    releaseFirstHandle?.();
    const first = await waitFor(() => harness.sent.find((message) => (
      message.id === 'chained-dialog-first'
    )));
    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({ handled: true, type: 'confirm', action: 'accept' });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'chained-dialog-state',
      operationId: 'chained-dialog-state-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_dialog_state,
      actionScope: 'get_dialog_state',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const state = await waitFor(() => harness.sent.find((message) => (
      message.id === 'chained-dialog-state'
    )));
    expect(state.error).toBeUndefined();
    expect(state.result).toMatchObject({ pending: true, type: 'alert' });
    expect(JSON.stringify([first, state])).not.toContain('surface-secret-canary-chained');

    releaseSecondHandle?.();
    const second = await waitFor(() => harness.sent.find((message) => (
      message.id === 'chained-dialog-second'
    )));
    expect(second.error).toBeUndefined();
    expect(second.result).toMatchObject({ handled: true, type: 'alert', action: 'dismiss' });
  });

  it('rejects a wrong-owner lease return before it can abort the owner active operation', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'owner-wait',
      operationId: 'owner-wait-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.wait,
      actionScope: 'wait',
      deadlineAt: Date.now() + 2_000,
      params: { timeoutMs: 1_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'foreign-return',
      operationId: 'owner-wait-operation',
      leaseId,
      ...owner,
      agentId: 'foreign-agent',
      method: 'lease.return',
      actionScope: 'lease:return',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const rejected = await waitFor(() => harness.sent.find((message) => (
      message.id === 'foreign-return'
    )));
    expect(rejected.error).toMatchObject({
      code: 'RELAY_LEASE_NOT_OWNED',
      delivery: 'not_attempted',
    });
    expect(harness.sent.some((message) => message.id === 'owner-wait')).toBe(false);
    expect(harness.sent.some((message) => (
      message.type === 'lease.returned' && message.leaseId === leaseId
    ))).toBe(false);

    socket.receive({
      type: 'cancel',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      leaseId,
      ...owner,
      operationId: 'owner-wait-operation',
      reason: 'unit-test-cleanup',
    });
    const cancelled = await waitFor(() => harness.sent.find((message) => (
      message.id === 'owner-wait'
    )));
    expect(cancelled.error).toMatchObject({
      code: 'RELAY_OPERATION_CANCELLED',
      delivery: 'not_attempted',
    });
    expect(harness.tabs.get(7)?.windowId).toBe(20);
  });

  it('reports unknown delivery when drag fails after input was partially dispatched', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'drag-delivery-dom',
      operationId: 'drag-delivery-dom-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.get_dom_snapshot,
      actionScope: 'get_dom_snapshot',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const snapshot = await waitFor(() => harness.sent.find((message) => (
      message.id === 'drag-delivery-dom'
    )));
    const targetRef = (snapshot.result as { elements: Array<{ ref: string }> }).elements[0];
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');
    let inputDeliveryCount = 0;
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await originalSendCommand?.(target, method, params);
      if (method === 'Input.dispatchMouseEvent') {
        inputDeliveryCount += 1;
        if (inputDeliveryCount === 3) throw new Error('Chrome rejected a partially delivered drag');
      }
      return result;
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'drag-partial-delivery',
      operationId: 'drag-partial-delivery-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.drag,
      actionScope: 'drag',
      deadlineAt: Date.now() + 2_000,
      params: { targetRef, destinationTargetRef: targetRef },
    });
    const failed = await waitFor(() => harness.sent.find((message) => (
      message.id === 'drag-partial-delivery'
    )));
    expect(failed.error).toMatchObject({
      code: 'RELAY_COMMAND_FAILED',
      delivery: 'unknown',
    });
    const inputTypes = harness.debuggerCommands
      .filter((command) => command.method === 'Input.dispatchMouseEvent')
      .map((command) => (command.params as { type?: string }).type);
    expect(inputTypes).toEqual(expect.arrayContaining(['mousePressed', 'mouseMoved', 'mouseReleased']));
  });

  it('rejects hover and drag without fresh opaque target refs before input delivery', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'hover-selector-only',
      operationId: 'hover-selector-only-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.hover,
      actionScope: 'hover',
      deadlineAt: Date.now() + 2_000,
      params: { selector: 'button' },
    });
    const hover = await waitFor(() => harness.sent.find((message) => message.id === 'hover-selector-only'));
    expect(hover.error).toMatchObject({ code: 'RELAY_TARGET_CHANGED', delivery: 'not_attempted' });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'drag-destination-missing',
      operationId: 'drag-destination-missing-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.drag,
      actionScope: 'drag',
      deadlineAt: Date.now() + 2_000,
      params: { targetRef: { ref: 'opaque-but-not-resolved' } },
    });

    const drag = await waitFor(() => harness.sent.find((message) => message.id === 'drag-destination-missing'));
    expect(drag.error).toMatchObject({ code: 'RELAY_TARGET_CHANGED', delivery: 'not_attempted' });
    expect(harness.debuggerCommands.some((command) => command.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('rejects Relay upload without both Host approval and a fresh opaque file-input ref', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const canaryPath = '/private/tmp/surface-secret-canary-rejected-upload.txt';

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'upload-missing-approval',
      operationId: 'upload-missing-approval-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.upload_file,
      actionScope: 'upload_file',
      deadlineAt: Date.now() + 2_000,
      params: { targetRef: { ref: 'unresolved-file-input' } },
    });
    const missingApproval = await waitFor(() => harness.sent.find((message) => (
      message.id === 'upload-missing-approval'
    )));
    expect(missingApproval.error).toMatchObject({
      code: 'RELAY_FILE_UPLOAD_BLOCKED',
      delivery: 'not_attempted',
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'upload-selector-only',
      operationId: 'upload-selector-only-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.upload_file,
      actionScope: 'upload_file',
      deadlineAt: Date.now() + 2_000,
      params: {
        selector: 'input[type=file]',
        uploadApprovalRef: 'upload-approval-opaque',
        uploadFilePath: canaryPath,
      },
    });
    const selectorOnly = await waitFor(() => harness.sent.find((message) => (
      message.id === 'upload-selector-only'
    )));
    expect(selectorOnly.error).toMatchObject({
      code: 'RELAY_TARGET_CHANGED',
      delivery: 'not_attempted',
    });
    expect(JSON.stringify(missingApproval)).not.toContain(canaryPath);
    expect(JSON.stringify(selectorOnly)).not.toContain(canaryPath);
    expect(harness.debuggerCommands.some((command) => command.method === 'DOM.setFileInputFiles')).toBe(false);
  });

  it('drops legacy persisted leases and pending approvals that lack conversation ownership', async () => {
    const harness = createHarness({
      browserRelayLeasesV2: [{
        leaseId: 'lease-legacy-without-owner',
        surfaceSessionId: 'surface-session-legacy',
        runId: 'run-legacy',
        agentId: 'agent-legacy',
        nativeTabId: 7,
        state: 'leased',
      }],
      browserRelayPendingLeaseV2: {
        requestId: 'request-legacy',
        surfaceSessionId: 'surface-session-legacy',
        runId: 'run-legacy',
        agentId: 'agent-legacy',
        domainScopes: ['selected-tab-origin'],
        actionScopes: ['screenshot'],
        expiresAt: Date.now() + 60_000,
      },
    });
    await connectHarness(harness);
    const hello = harness.sent.find((message) => message.type === 'hello');
    expect(hello?.orphanedLeaseIds).toEqual([]);
    expect(harness.sessionStore.browserRelayLeasesV2).toEqual([]);
    expect(harness.sessionStore.browserRelayPendingLeaseV2).toBeNull();
    const status = await harness.runtimeMessage({ type: 'getStatus' });
    expect(status.pendingLease).toBeNull();
    expect(status.activeLeaseCount).toBe(0);
  });

  it('cancels pending consent before any tab move or debugger attachment', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const now = Date.now();
    socket.receive({
      type: 'lease.request',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      requestId: 'request-cancel-before-approval',
      ...owner,
      domainScopes: ['selected-tab-origin'],
      actionScopes: ['screenshot', 'lease:return'],
      consentDeadlineAt: now + 10_000,
      expiresAt: now + 60_000,
    });
    await waitFor(() => (
      (harness.sessionStore.browserRelayPendingLeaseV2 as Record<string, unknown> | undefined)?.requestId
      === 'request-cancel-before-approval'
    ));
    socket.receive({
      type: 'lease.request.cancel',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      requestId: 'request-cancel-before-approval',
      ...owner,
      reason: 'host-consent-timeout',
    });
    await waitFor(() => harness.sessionStore.browserRelayPendingLeaseV2 === null);
    await expect(harness.runtimeMessage({ type: 'approvePendingLease' })).resolves.toMatchObject({
      error: {
        code: 'RELAY_LEASE_REQUIRED',
        message: expect.stringContaining('no pending lease'),
      },
    });
    expect(harness.tabMoves).toHaveLength(0);
    expect(harness.chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it('reconciles a tab returned while disconnected after the next v2 handshake', async () => {
    const harness = createHarness({
      browserRelayLeasesV2: [{
        leaseId: 'lease-returned-offline',
        tabRef: 'tab-returned-offline',
        agentWindowRef: 'agent-window-returned-offline',
        originalWindowRef: 'original-window-returned-offline',
        ...owner,
        nativeTabId: 7,
        state: 'returned',
        actions: ['lease:return'],
        expiresAtMs: Date.now() + 60_000,
        original: { windowId: 3, index: 0, pinned: true, active: true },
      }],
    });

    await connectHarness(harness);
    const returned = await waitFor(() => harness.sent.find((message) => (
      message.type === 'lease.returned' && message.leaseId === 'lease-returned-offline'
    )));
    expect(returned).toMatchObject({ leaseId: 'lease-returned-offline', ...owner });
  });

  it('uses the host lease-return command to cancel an active operation before restoring the tab', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'host-return-wait',
      operationId: 'host-return-wait-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.wait,
      actionScope: 'wait',
      deadlineAt: Date.now() + 2_000,
      params: { timeoutMs: 1_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'host-return-command',
      operationId: 'host-return-command-operation',
      leaseId,
      ...owner,
      method: 'lease.return',
      actionScope: 'lease:return',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });

    const wait = await waitFor(() => harness.sent.find((message) => message.id === 'host-return-wait'));
    expect(wait.error).toMatchObject({
      code: 'RELAY_OPERATION_CANCELLED',
      delivery: 'not_attempted',
    });
    const returned = await waitFor(() => harness.sent.find((message) => (
      message.id === 'host-return-command'
    )));
    expect(returned.error).toBeUndefined();
    expect(returned.result).toMatchObject({ returned: true, leaseId });
    expect(harness.tabs.get(7)).toMatchObject({ windowId: 3, pinned: true, active: true });
  });

  it('cancels active input before a popup return restores the borrowed tab', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    const targetRef = await firstDomTargetRef(harness, socket, leaseId, 'popup-return');
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');

    let releaseInput: (() => void) | undefined;
    let notifyInputStarted: (() => void) | undefined;
    const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
    const inputStarted = new Promise<void>((resolve) => { notifyInputStarted = resolve; });
    let heldInput = false;
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await originalSendCommand?.(target, method, params);
      if (!heldInput && method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        heldInput = true;
        notifyInputStarted?.();
        await inputGate;
      }
      return result;
    });
    harness.chrome.debugger.detach.mockImplementation(async () => {
      releaseInput?.();
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'popup-return-drag',
      operationId: 'popup-return-drag-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.drag,
      actionScope: 'drag',
      deadlineAt: Date.now() + 2_000,
      params: { targetRef, destinationTargetRef: targetRef },
    });
    await inputStarted;
    const popupReturn = harness.runtimeMessage({ type: 'returnCurrentLease' });
    await expect(popupReturn).resolves.toMatchObject({ returned: true, leaseId });

    const drag = await waitFor(() => harness.sent.find((message) => (
      message.id === 'popup-return-drag'
    )));
    expect(drag.error).toMatchObject({
      code: 'RELAY_OPERATION_CANCELLED',
      delivery: 'unknown',
    });
    expect(harness.debuggerCommands.filter((command) => (
      command.method === 'Input.dispatchMouseEvent'
    )).map((command) => (command.params as { type?: string }).type)).toEqual([
      'mouseMoved',
      'mousePressed',
    ]);
    expect(harness.tabs.get(7)).toMatchObject({ windowId: 3, index: 0, pinned: true, active: true });
    expect(harness.sent).toContainEqual(expect.objectContaining({
      type: 'lease.returned',
      leaseId,
      ...owner,
    }));
  });

  it('cancels active input when lease expiry automatically returns the borrowed tab', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket, 100);
    const targetRef = await firstDomTargetRef(harness, socket, leaseId, 'expiry-return');
    const originalSendCommand = harness.chrome.debugger.sendCommand.getMockImplementation();
    expect(originalSendCommand).toBeTypeOf('function');

    let releaseInput: (() => void) | undefined;
    let notifyInputStarted: (() => void) | undefined;
    const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
    const inputStarted = new Promise<void>((resolve) => { notifyInputStarted = resolve; });
    let heldInput = false;
    harness.chrome.debugger.sendCommand.mockImplementation(async (
      target: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const result = await originalSendCommand?.(target, method, params);
      if (!heldInput && method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        heldInput = true;
        notifyInputStarted?.();
        await inputGate;
      }
      return result;
    });
    harness.chrome.debugger.detach.mockImplementation(async () => {
      releaseInput?.();
    });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'expiry-return-drag',
      operationId: 'expiry-return-drag-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.drag,
      actionScope: 'drag',
      deadlineAt: Date.now() + 2_000,
      params: { targetRef, destinationTargetRef: targetRef },
    });
    await inputStarted;
    await new Promise((resolve) => setTimeout(resolve, 120));
    harness.alarmsOnAlarm.emit({ name: 'code-agent-relay-keepalive' } as never);

    await waitFor(() => harness.sent.find((message) => (
      message.type === 'lease.returned' && message.leaseId === leaseId
    )));
    const drag = await waitFor(() => harness.sent.find((message) => (
      message.id === 'expiry-return-drag'
    )));
    expect(drag.error).toMatchObject({
      code: 'RELAY_OPERATION_CANCELLED',
      delivery: 'unknown',
    });
    expect(harness.debuggerCommands.filter((command) => (
      command.method === 'Input.dispatchMouseEvent'
    )).map((command) => (command.params as { type?: string }).type)).toEqual([
      'mouseMoved',
      'mousePressed',
    ]);
    expect(harness.tabs.get(7)).toMatchObject({ windowId: 3, pinned: true, active: true });
  });

  it('automatically returns a lease even after an expired command records the expired state', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket, 100);
    await new Promise((resolve) => setTimeout(resolve, 120));
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'expired-command-before-alarm',
      operationId: 'expired-command-before-alarm-operation',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.screenshot,
      actionScope: 'screenshot',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const expired = await waitFor(() => harness.sent.find((message) => (
      message.id === 'expired-command-before-alarm'
    )));
    expect(expired.error).toMatchObject({
      code: 'RELAY_LEASE_EXPIRED',
      delivery: 'not_attempted',
    });
    harness.alarmsOnAlarm.emit({ name: 'code-agent-relay-keepalive' } as never);
    const returned = await waitFor(() => harness.sent.find((message) => (
      message.type === 'lease.returned' && message.leaseId === leaseId
    )));
    expect(returned).toMatchObject({ leaseId, ...owner });
    expect(harness.chrome.debugger.detach).toHaveBeenCalledTimes(1);
    expect(harness.tabs.get(7)).toMatchObject({ windowId: 3, pinned: true });
  });

  it('reports owner-scoped recovery_required when original tab placement cannot be restored', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    harness.chrome.windows.get.mockRejectedValueOnce(new Error('original window closed'));
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'command-return-failed',
      operationId: 'operation-return-failed',
      leaseId,
      ...owner,
      method: 'lease.return',
      actionScope: 'lease:return',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const recovery = await waitFor(() => harness.sent.find((message) => (
      message.type === 'lease.recovery_required' && message.leaseId === leaseId
    )));
    expect(recovery).toMatchObject({ leaseId, ...owner });
    expect(recovery.error).toMatchObject({ code: 'RELAY_TAB_RETURN_FAILED', delivery: 'unknown' });
    const response = await waitFor(() => harness.sent.find((message) => message.id === 'command-return-failed'));
    expect(response.error).toMatchObject({ code: 'RELAY_TAB_RETURN_FAILED', delivery: 'unknown' });
    expect(harness.sent.some((message) => message.type === 'lease.returned' && message.leaseId === leaseId)).toBe(false);
  });

  it('rejects cross-owner and raw native-target commands before delivery', async () => {
    const harness = createHarness();
    const socket = await connectHarness(harness);
    const leaseId = await approveLease(harness, socket);
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'command-cross-owner',
      operationId: 'operation-cross-owner',
      leaseId,
      ...owner,
      conversationId: 'conversation-other',
      method: BROWSER_RELAY_ACTION_METHODS_V2.click,
      actionScope: 'click',
      deadlineAt: Date.now() + 2_000,
      params: { selector: 'button' },
    });
    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'command-native-target',
      operationId: 'operation-native-target',
      leaseId,
      ...owner,
      method: BROWSER_RELAY_ACTION_METHODS_V2.screenshot,
      actionScope: 'screenshot',
      deadlineAt: Date.now() + 2_000,
      params: { nested: { windowId: 9 } },
    });
    const crossOwner = await waitFor(() => harness.sent.find((message) => message.id === 'command-cross-owner'));
    const nativeTarget = await waitFor(() => harness.sent.find((message) => message.id === 'command-native-target'));
    expect(crossOwner.error).toMatchObject({ code: 'RELAY_LEASE_NOT_OWNED', delivery: 'not_attempted' });
    expect(nativeTarget.error).toMatchObject({ code: 'RELAY_TARGET_CHANGED', delivery: 'not_attempted' });

    socket.receive({
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id: 'command-return-confusion',
      operationId: 'operation-return-confusion',
      leaseId,
      ...owner,
      method: 'lease.return',
      actionScope: 'screenshot',
      deadlineAt: Date.now() + 2_000,
      params: {},
    });
    const confusedReturn = await waitFor(() => harness.sent.find((message) => message.id === 'command-return-confusion'));
    expect(confusedReturn.error).toMatchObject({ code: 'RELAY_ACTION_NOT_ALLOWED', delivery: 'not_attempted' });
    expect(harness.tabs.get(7)?.windowId).toBe(20);
  });
});
