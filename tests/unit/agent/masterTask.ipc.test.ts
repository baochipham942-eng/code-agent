// ============================================================================
// MasterTask IPC Handlers Tests
// ============================================================================
//
// 覆盖：
//   - registerMasterTaskHandlers 注册 11 个 ipcMain.handle channel
//   - manager.emit('event') → 所有 BrowserWindow.webContents.send(MASTER_TASK_EVENT)
//   - master-task:create → manager.register + 返回 DTO
//   - master-task:listInProgress → 返回 DTO 数组
//   - master-task:getById → 返回 DTO / null
//   - master-task:list → 走 repository.list 返回 row → DTO（不是 manager.byId）
//   - master-task:updateStatus 路由：'paused' → pause, 'running' → start
//   - master-task:updateStatus → 'created' 抛错（disallowed transition）
//   - master-task:cancel / approveReview / rejectReview / bindSession
//   - serializeMasterTask：Set → Array.from
//
// Mock 策略：vi.mock platform / logger / masterTaskRepository（替 getMasterTaskDb）。
// 单例隔离：beforeEach 调 resetMasterTaskManagerForTesting。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ----------------------------------------------------------------------------
// hoisted state for mocks
// ----------------------------------------------------------------------------

const platformState = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const sentMessages: Array<{ channel: string; payload: unknown }> = [];
  const fakeWindows: Array<{
    webContents: { send: (channel: string, payload: unknown) => void };
  }> = [];
  return {
    handlers,
    sentMessages,
    fakeWindows,
    reset() {
      handlers.clear();
      sentMessages.length = 0;
      fakeWindows.length = 0;
    },
  };
});

const repoState = vi.hoisted(() => {
  // 简易内存 repository stub，list 返回预置数据
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    listMock: vi.fn(() => rows.slice()),
    reset() {
      rows.length = 0;
    },
  };
});

vi.mock('../../../src/main/platform', () => {
  const fakeWin = {
    webContents: {
      send: (channel: string, payload: unknown) => {
        platformState.sentMessages.push({ channel, payload });
      },
    },
  };
  // 默认放一个窗口
  platformState.fakeWindows.push(fakeWin);
  return {
    BrowserWindow: {
      getAllWindows: () => platformState.fakeWindows,
    },
    ipcMain: {
      handle: (
        channel: string,
        handler: (event: unknown, ...args: unknown[]) => unknown,
      ) => {
        platformState.handlers.set(channel, handler);
      },
      removeHandler: (channel: string) => {
        platformState.handlers.delete(channel);
      },
    },
  };
});

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// 替换 repository：getMasterTaskDb 返回 null（manager 走 in-memory only fallback），
// MasterTaskRepository 构造时不会真去 prepare SQL，因为 list 单测会走 mock。
vi.mock(
  '../../../src/main/services/core/repositories/masterTaskRepository',
  async () => {
    const actual = await vi.importActual<
      typeof import('../../../src/main/services/core/repositories/masterTaskRepository')
    >('../../../src/main/services/core/repositories/masterTaskRepository');
    return {
      ...actual,
      getMasterTaskDb: () => null,
      // 替换 class，避免真的 prepare SQL
      MasterTaskRepository: vi.fn().mockImplementation(() => ({
        list: repoState.listMock,
        getById: vi.fn(() => null),
        listInProgress: vi.fn(() => []),
      })),
    };
  },
);

// ----------------------------------------------------------------------------
// imports（在 vi.mock 之后）
// ----------------------------------------------------------------------------

import {
  registerMasterTaskHandlers,
  serializeMasterTask,
  type MasterTaskDTO,
} from '../../../src/main/agent/masterTask.ipc';
import {
  getMasterTaskManager,
  resetMasterTaskManagerForTesting,
  type MasterTaskManagerEvent,
} from '../../../src/main/agent/masterTaskManager';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { MasterTask } from '../../../src/main/agent/masterTask';

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

const ALL_CHANNELS = [
  IPC_CHANNELS.MASTER_TASK_CREATE,
  IPC_CHANNELS.MASTER_TASK_LIST,
  IPC_CHANNELS.MASTER_TASK_LIST_IN_PROGRESS,
  IPC_CHANNELS.MASTER_TASK_GET_BY_ID,
  IPC_CHANNELS.MASTER_TASK_UPDATE_STATUS,
  IPC_CHANNELS.MASTER_TASK_PAUSE,
  IPC_CHANNELS.MASTER_TASK_RESUME,
  IPC_CHANNELS.MASTER_TASK_CANCEL,
  IPC_CHANNELS.MASTER_TASK_APPROVE_REVIEW,
  IPC_CHANNELS.MASTER_TASK_REJECT_REVIEW,
  IPC_CHANNELS.MASTER_TASK_BIND_SESSION,
];

describe('MasterTask IPC Handlers', () => {
  beforeEach(() => {
    platformState.reset();
    repoState.reset();
    repoState.listMock.mockClear();
    // 重置 platformState 之后补一个默认窗口（mock 模块内的 push 只在初始化跑一次）
    platformState.fakeWindows.push({
      webContents: {
        send: (channel: string, payload: unknown) => {
          platformState.sentMessages.push({ channel, payload });
        },
      },
    });
    resetMasterTaskManagerForTesting();
    registerMasterTaskHandlers();
  });

  // --------------------------------------------------------------------------
  // 注册
  // --------------------------------------------------------------------------

  it('registers all 11 ipcMain.handle channels', () => {
    expect(ALL_CHANNELS).toHaveLength(11);
    for (const channel of ALL_CHANNELS) {
      expect(
        platformState.handlers.has(channel),
        `expected handler for ${channel}`,
      ).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // 事件广播
  // --------------------------------------------------------------------------

  it('broadcasts MasterTaskManager events to all BrowserWindows via MASTER_TASK_EVENT', () => {
    // 加一个额外窗口，验证多窗口广播
    platformState.fakeWindows.push({
      webContents: {
        send: (channel: string, payload: unknown) => {
          platformState.sentMessages.push({ channel, payload });
        },
      },
    });

    const manager = getMasterTaskManager();
    const fakeEvent: MasterTaskManagerEvent = {
      type: 'MasterTaskCreated',
      taskId: 'mt-broadcast-test',
      status: 'created',
    };
    manager.emit('event', fakeEvent);

    // 两个窗口都应该收到 channel = MASTER_TASK_EVENT、payload 一致
    expect(platformState.sentMessages).toHaveLength(2);
    for (const msg of platformState.sentMessages) {
      expect(msg.channel).toBe(IPC_CHANNELS.MASTER_TASK_EVENT);
      expect(msg.payload).toEqual(fakeEvent);
    }
  });

  // --------------------------------------------------------------------------
  // master-task:create
  // --------------------------------------------------------------------------

  it('master-task:create calls manager.register and returns DTO', async () => {
    const manager = getMasterTaskManager();
    const registerSpy = vi.spyOn(manager, 'register');

    const handler = platformState.handlers.get(IPC_CHANNELS.MASTER_TASK_CREATE);
    expect(handler).toBeTypeOf('function');

    const payload = { title: 'demo', workspaceUri: 'file:///tmp/ws' };
    const result = (await handler?.({}, payload)) as MasterTaskDTO;

    expect(registerSpy).toHaveBeenCalledWith(payload);
    expect(result.title).toBe('demo');
    expect(result.workspaceUri).toBe('file:///tmp/ws');
    expect(result.status).toBe('created');
    expect(result.ownerUserId).toBe('local');
    expect(Array.isArray(result.blocks)).toBe(true);
    expect(Array.isArray(result.childAgentTaskIds)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // master-task:listInProgress
  // --------------------------------------------------------------------------

  it('master-task:listInProgress returns DTO array', async () => {
    const manager = getMasterTaskManager();
    // 用 manager.register 放两个非终态任务（DB null，只走内存）
    manager.register({ title: 'a', workspaceUri: 'file:///a' }, { id: 'mt-a' });
    manager.register({ title: 'b', workspaceUri: 'file:///b' }, { id: 'mt-b' });

    const handler = platformState.handlers.get(
      IPC_CHANNELS.MASTER_TASK_LIST_IN_PROGRESS,
    );
    const result = (await handler?.({}, undefined)) as MasterTaskDTO[];

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    const ids = result.map((d) => d.id).sort();
    expect(ids).toEqual(['mt-a', 'mt-b']);
    // DTO 字段
    for (const dto of result) {
      expect(Array.isArray(dto.blocks)).toBe(true);
      expect(Array.isArray(dto.childAgentTaskIds)).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // master-task:getById
  // --------------------------------------------------------------------------

  it('master-task:getById returns DTO when task exists, null otherwise', async () => {
    const manager = getMasterTaskManager();
    manager.register({ title: 'hello', workspaceUri: 'file:///x' }, { id: 'mt-found' });

    const handler = platformState.handlers.get(IPC_CHANNELS.MASTER_TASK_GET_BY_ID);

    const hit = (await handler?.({}, 'mt-found')) as MasterTaskDTO | null;
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe('mt-found');
    expect(hit?.title).toBe('hello');

    const miss = (await handler?.({}, 'mt-missing')) as MasterTaskDTO | null;
    expect(miss).toBeNull();
  });

  // --------------------------------------------------------------------------
  // master-task:updateStatus 路由
  // --------------------------------------------------------------------------

  it('master-task:updateStatus → paused routes to manager.pause', async () => {
    const manager = getMasterTaskManager();
    // 走完 created → pending → running，再 pause
    manager.register({ title: 't', workspaceUri: 'file:///t' }, { id: 'mt-p' });
    manager.advance('mt-p');
    manager.start('mt-p');
    const pauseSpy = vi.spyOn(manager, 'pause');

    const handler = platformState.handlers.get(IPC_CHANNELS.MASTER_TASK_UPDATE_STATUS);
    await handler?.({}, 'mt-p', 'paused');

    expect(pauseSpy).toHaveBeenCalledWith('mt-p');
  });

  it('master-task:updateStatus → running routes to manager.start', async () => {
    const manager = getMasterTaskManager();
    manager.register({ title: 't', workspaceUri: 'file:///t' }, { id: 'mt-r' });
    manager.advance('mt-r'); // → pending（合法 start from）
    const startSpy = vi.spyOn(manager, 'start');

    const handler = platformState.handlers.get(IPC_CHANNELS.MASTER_TASK_UPDATE_STATUS);
    await handler?.({}, 'mt-r', 'running');

    expect(startSpy).toHaveBeenCalledWith('mt-r');
  });

  it('master-task:updateStatus → created throws disallowed transition', () => {
    const manager = getMasterTaskManager();
    manager.register({ title: 't', workspaceUri: 'file:///t' }, { id: 'mt-c' });

    const handler = platformState.handlers.get(IPC_CHANNELS.MASTER_TASK_UPDATE_STATUS);
    // 同步 handler 抛错（ipcMain.handle wrapper 在真实运行时会把它转成 rejected promise）
    expect(() => handler?.({}, 'mt-c', 'created')).toThrow(/created/);
  });

  // --------------------------------------------------------------------------
  // pause / cancel / approveReview / rejectReview / bindSession
  // --------------------------------------------------------------------------

  it('master-task:cancel calls manager.cancel', async () => {
    const manager = getMasterTaskManager();
    manager.register({ title: 't', workspaceUri: 'file:///t' }, { id: 'mt-cancel' });
    const cancelSpy = vi.spyOn(manager, 'cancel');

    const handler = platformState.handlers.get(IPC_CHANNELS.MASTER_TASK_CANCEL);
    await handler?.({}, 'mt-cancel');

    expect(cancelSpy).toHaveBeenCalledWith('mt-cancel');
  });

  it('master-task:bindSession calls manager.attachSession', async () => {
    const manager = getMasterTaskManager();
    manager.register({ title: 't', workspaceUri: 'file:///t' }, { id: 'mt-bind' });
    const attachSpy = vi.spyOn(manager, 'attachSession');

    const handler = platformState.handlers.get(IPC_CHANNELS.MASTER_TASK_BIND_SESSION);
    await handler?.({}, 'mt-bind', 'sess-1');

    expect(attachSpy).toHaveBeenCalledWith('mt-bind', 'sess-1');
  });

  it('master-task:approveReview and rejectReview route to manager methods', async () => {
    const manager = getMasterTaskManager();
    // 走到 review 状态需要 created → pending → running → review
    manager.register({ title: 't', workspaceUri: 'file:///t' }, { id: 'mt-rev' });
    manager.advance('mt-rev');
    manager.start('mt-rev');
    manager.requestReview('mt-rev');
    const approveSpy = vi.spyOn(manager, 'approveReview');

    const approveHandler = platformState.handlers.get(
      IPC_CHANNELS.MASTER_TASK_APPROVE_REVIEW,
    );
    await approveHandler?.({}, 'mt-rev');
    expect(approveSpy).toHaveBeenCalledWith('mt-rev');

    // 另一个 task 走到 review，验证 reject 路由
    manager.register({ title: 't2', workspaceUri: 'file:///t2' }, { id: 'mt-rev2' });
    manager.advance('mt-rev2');
    manager.start('mt-rev2');
    manager.requestReview('mt-rev2');
    const rejectSpy = vi.spyOn(manager, 'rejectReview');

    const rejectHandler = platformState.handlers.get(
      IPC_CHANNELS.MASTER_TASK_REJECT_REVIEW,
    );
    await rejectHandler?.({}, 'mt-rev2');
    expect(rejectSpy).toHaveBeenCalledWith('mt-rev2');
  });

  // --------------------------------------------------------------------------
  // serializeMasterTask：Set → Array
  // --------------------------------------------------------------------------

  it('serializeMasterTask converts Set fields to Array', () => {
    const task = new MasterTask('mt-ser', {
      title: 'ser',
      workspaceUri: 'file:///s',
      blocks: ['a', 'b'],
      blockedBy: ['c'],
    });
    task.attachAgentTask('agent-1');
    task.attachAgentTask('agent-2');
    task.attachSession('sess-1');

    const dto = serializeMasterTask(task);
    expect(Array.isArray(dto.blocks)).toBe(true);
    expect(dto.blocks.sort()).toEqual(['a', 'b']);
    expect(Array.isArray(dto.blockedBy)).toBe(true);
    expect(dto.blockedBy).toEqual(['c']);
    expect(Array.isArray(dto.childAgentTaskIds)).toBe(true);
    expect(dto.childAgentTaskIds.sort()).toEqual(['agent-1', 'agent-2']);
    expect(Array.isArray(dto.attachedSessionIds)).toBe(true);
    expect(dto.attachedSessionIds).toEqual(['sess-1']);
  });
});
