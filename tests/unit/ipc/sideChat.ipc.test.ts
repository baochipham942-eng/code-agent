import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { SideChatSchemas } from '../../../src/shared/ipc/schemas';

const execute = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({ execute }),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ getDefinition: () => undefined }),
}));

import { registerSideChatHandlers } from '../../../src/host/ipc/sideChat.ipc';
import { handlers, ipcHost } from '../../../src/host/platform/ipcRegistry';
import * as databaseModule from '../../../src/host/services/core/databaseService';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { SessionManager } from '../../../src/host/services/infra/sessionManager';

const seededMessages = [{ id: 'm1', role: 'user', content: 'seeded', timestamp: 1 }] as Message[];

type InvokeHandler = (event: unknown, payload: unknown) => Promise<unknown>;

function askHandler(): InvokeHandler {
  const handler = handlers.get(IPC_CHANNELS.SIDE_CHAT_ASK);
  if (!handler) throw new Error('missing side-chat ask handler');
  return handler as InvokeHandler;
}

function abortHandler(): InvokeHandler {
  const handler = handlers.get(IPC_CHANNELS.SIDE_CHAT_ABORT);
  if (!handler) throw new Error('missing side-chat abort handler');
  return handler as InvokeHandler;
}

describe('side chat IPC', () => {
  const dbAddMessage = vi.fn();
  const dbUpdateMessage = vi.fn();
  const dbReplaceMessages = vi.fn();

  function writeSpies() {
    return [
      SessionManager.prototype.addMessage,
      SessionManager.prototype.addMessageToSession,
      SessionManager.prototype.updateMessage,
      SessionManager.prototype.replaceMessages,
      SessionManager.prototype.getSession,
      DatabaseService.prototype.addMessage,
      DatabaseService.prototype.updateMessage,
      DatabaseService.prototype.replaceMessages,
      dbAddMessage,
      dbUpdateMessage,
      dbReplaceMessages,
    ];
  }

  beforeEach(() => {
    execute.mockReset();
    dbAddMessage.mockReset();
    dbUpdateMessage.mockReset();
    dbReplaceMessages.mockReset();
    vi.spyOn(databaseModule, 'getDatabase').mockReturnValue({
      getSession: () => ({
        modelConfig: { provider: 'longcat', model: 'LongCat-2.0' },
        workingDirectory: '/tmp/work',
        workspace: '/tmp/work',
      }),
      addMessage: dbAddMessage,
      updateMessage: dbUpdateMessage,
      replaceMessages: dbReplaceMessages,
    } as never);
    vi.spyOn(SessionManager.prototype, 'addMessage').mockResolvedValue(undefined);
    vi.spyOn(SessionManager.prototype, 'addMessageToSession').mockResolvedValue(undefined);
    vi.spyOn(SessionManager.prototype, 'updateMessage').mockResolvedValue(undefined);
    vi.spyOn(SessionManager.prototype, 'replaceMessages').mockResolvedValue(undefined);
    vi.spyOn(SessionManager.prototype, 'getSession').mockRejectedValue(new Error('getSession must not run'));
    vi.spyOn(DatabaseService.prototype, 'addMessage').mockImplementation(() => undefined);
    vi.spyOn(DatabaseService.prototype, 'updateMessage').mockImplementation(() => undefined);
    vi.spyOn(DatabaseService.prototype, 'replaceMessages').mockImplementation(() => undefined);
    vi.spyOn(SessionManager.prototype, 'getSessionRuntimeState').mockReturnValue({
      compressionStateJson: null,
      persistentSystemContext: [],
    });
    vi.spyOn(SessionManager.prototype, 'getRecentMessages').mockResolvedValue(seededMessages);
    registerSideChatHandlers();
  });

  afterEach(() => {
    ipcHost.removeHandler(IPC_CHANNELS.SIDE_CHAT_ASK);
    ipcHost.removeHandler(IPC_CHANNELS.SIDE_CHAT_ABORT);
    vi.restoreAllMocks();
  });

  it('keeps the channel names aligned with the schema', () => {
    expect(IPC_CHANNELS.SIDE_CHAT_ASK).toBe('side-chat:ask');
    expect(IPC_CHANNELS.SIDE_CHAT_ABORT).toBe('side-chat:abort');
    expect(SideChatSchemas.ASK.channel).toBe(IPC_CHANNELS.SIDE_CHAT_ASK);
    expect(SideChatSchemas.ABORT.channel).toBe(IPC_CHANNELS.SIDE_CHAT_ABORT);
  });

  it('returns the answer without persisting and passes an empty tool list', async () => {
    execute.mockImplementation(async (request: {
      prompt: string;
      config: { availableTools: unknown };
      context: { events: { emit: (event: string, data: unknown) => void } };
    }) => {
      request.context.events.emit('side-chat', { prompt: request.prompt });
      return { success: true, output: 'side answer', toolsUsed: [], iterations: 1 };
    });

    const result = await askHandler()(null, {
      sessionId: 's1',
      question: '旁边问一句',
      requestId: 'r1',
    });

    expect(result).toEqual({ answer: 'side answer' });
    const request = execute.mock.calls[0][0] as { config: { availableTools: unknown }; prompt: string };
    expect(request.prompt).toBe('旁边问一句');
    expect(request.config.availableTools).toEqual([]);
    expect(SessionManager.prototype.getRecentMessages).toHaveBeenCalledWith('s1', 12);
    for (const spy of writeSpies()) expect(spy).not.toHaveBeenCalled();
  });

  it('does not persist when the session is missing or the payload is invalid', async () => {
    vi.mocked(SessionManager.prototype.getSessionRuntimeState).mockReturnValue(null);
    const missing = await askHandler()(null, {
      sessionId: 'missing',
      question: 'hello',
      requestId: 'r-missing',
    });
    expect(missing).toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'SIDE_CHAT_SESSION_NOT_FOUND' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(SessionManager.prototype.getRecentMessages).not.toHaveBeenCalled();

    const invalid = await askHandler()(null, { sessionId: 's1', question: '', requestId: 'r-bad' });
    expect(invalid).toMatchObject({ success: false, error: { code: 'INVALID_PAYLOAD' } });
    for (const spy of writeSpies()) expect(spy).not.toHaveBeenCalled();
  });

  it('aborts the in-flight signal and does not return a late answer', async () => {
    let capturedSignal: AbortSignal | undefined;
    execute.mockImplementation((request: { context: { abortSignal: AbortSignal } }) => new Promise((resolve) => {
      capturedSignal = request.context.abortSignal;
      request.context.abortSignal.addEventListener('abort', () => {
        resolve({ success: true, output: 'late', toolsUsed: [], iterations: 1 });
      });
    }));

    const pending = askHandler()(null, {
      sessionId: 's1',
      question: 'hello',
      requestId: 'r-abort',
    });
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(await abortHandler()(null, { requestId: 'r-abort' })).toEqual({ aborted: true });
    expect(capturedSignal?.aborted).toBe(true);
    const result = await pending;
    expect(result).toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'SIDE_CHAT_ABORTED' },
    });
    expect(result).not.toEqual({ answer: 'late' });
    for (const spy of writeSpies()) expect(spy).not.toHaveBeenCalled();
    expect(await abortHandler()(null, { requestId: 'gone' })).toEqual({ aborted: false });
  });
});
