// ============================================================================
// ensureMasterTaskForSession 单测（P3-c1）
// ============================================================================
// 覆盖三条路径 + 边界：
//   - 未绑 master → register + attachSession + sessionRepo.updateMasterTaskId
//   - 已绑 + master 存在 → 仅 attachSession (幂等)
//   - 已绑 + master 不存在 (DB 不一致) → log warn, fall through 重建
//   - workingDirectory null/undefined → workspaceUri = ''
//   - title 空 / 全空白 → fallback `Session <id-prefix>`
//   - ownerUserId 默认 'local'
//   - sessionRepo.updateMasterTaskId 抛错 → 不冒泡，master 正常返回
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ensureMasterTaskForSession } from '../../../src/main/agent/ensureMasterTaskForSession';
import { getMasterTaskManager } from '../../../src/main/agent/masterTaskManager';
import type { SessionRepository } from '../../../src/main/services/core/repositories/SessionRepository';

vi.mock('../../../src/main/agent/masterTaskManager', () => ({
  getMasterTaskManager: vi.fn(),
}));

type ManagerMock = {
  getById: ReturnType<typeof vi.fn>;
  attachSession: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
};

type SessionRepoMock = Pick<SessionRepository, 'updateMasterTaskId'>;

function buildSessionRepoMock(): SessionRepoMock & {
  updateMasterTaskId: ReturnType<typeof vi.fn>;
} {
  const fn = vi.fn();
  return { updateMasterTaskId: fn as unknown as SessionRepository['updateMasterTaskId'] } as SessionRepoMock & {
    updateMasterTaskId: ReturnType<typeof vi.fn>;
  };
}

describe('ensureMasterTaskForSession', () => {
  let mockManager: ManagerMock;
  let mockSessionRepo: ReturnType<typeof buildSessionRepoMock>;

  beforeEach(() => {
    mockManager = {
      getById: vi.fn(),
      attachSession: vi.fn(),
      register: vi.fn(),
    };
    mockSessionRepo = buildSessionRepoMock();
    vi.mocked(getMasterTaskManager).mockReturnValue(
      mockManager as unknown as ReturnType<typeof getMasterTaskManager>,
    );
  });

  it('未绑 session → register + attachSession + updateMasterTaskId 都被调', () => {
    const fakeMaster = { id: 'mt-new-1' };
    mockManager.register.mockReturnValue(fakeMaster);

    const result = ensureMasterTaskForSession(
      {
        sessionId: 'sess-1',
        title: 'My Session',
        workingDirectory: '/path/to/project',
        existingMasterTaskId: null,
      },
      { sessionRepo: mockSessionRepo },
    );

    expect(mockManager.register).toHaveBeenCalledWith({
      title: 'My Session',
      workspaceUri: '/path/to/project',
      ownerUserId: 'local',
    });
    expect(mockManager.attachSession).toHaveBeenCalledWith('mt-new-1', 'sess-1');
    expect(mockSessionRepo.updateMasterTaskId).toHaveBeenCalledWith('sess-1', 'mt-new-1');
    expect(result).toBe(fakeMaster);
  });

  it('已绑 + master 存在 → 不重复 register，只 attachSession', () => {
    const existing = { id: 'mt-existing' };
    mockManager.getById.mockReturnValue(existing);

    const result = ensureMasterTaskForSession(
      {
        sessionId: 'sess-2',
        title: 'X',
        workingDirectory: '/',
        existingMasterTaskId: 'mt-existing',
      },
      { sessionRepo: mockSessionRepo },
    );

    expect(mockManager.getById).toHaveBeenCalledWith('mt-existing');
    expect(mockManager.register).not.toHaveBeenCalled();
    expect(mockManager.attachSession).toHaveBeenCalledWith('mt-existing', 'sess-2');
    expect(mockSessionRepo.updateMasterTaskId).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it('已绑 + master 不存在 → register 新的，写回新 master_task_id', () => {
    const fakeMaster = { id: 'mt-new-2' };
    mockManager.getById.mockReturnValue(null);
    mockManager.register.mockReturnValue(fakeMaster);

    const result = ensureMasterTaskForSession(
      {
        sessionId: 'sess-3',
        title: 'Y',
        workingDirectory: '/y',
        existingMasterTaskId: 'mt-stale',
      },
      { sessionRepo: mockSessionRepo },
    );

    expect(mockManager.getById).toHaveBeenCalledWith('mt-stale');
    expect(mockManager.register).toHaveBeenCalled();
    expect(mockManager.attachSession).toHaveBeenCalledWith('mt-new-2', 'sess-3');
    expect(mockSessionRepo.updateMasterTaskId).toHaveBeenCalledWith('sess-3', 'mt-new-2');
    expect(result).toBe(fakeMaster);
  });

  it('workingDirectory null → workspaceUri 为空字符串', () => {
    const fakeMaster = { id: 'mt-new-3' };
    mockManager.register.mockReturnValue(fakeMaster);

    ensureMasterTaskForSession(
      {
        sessionId: 'sess-4',
        title: 'Z',
        workingDirectory: null,
        existingMasterTaskId: null,
      },
      { sessionRepo: mockSessionRepo },
    );

    expect(mockManager.register).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceUri: '' }),
    );
  });

  it('workingDirectory undefined → workspaceUri 为空字符串', () => {
    const fakeMaster = { id: 'mt-new-4' };
    mockManager.register.mockReturnValue(fakeMaster);

    ensureMasterTaskForSession(
      {
        sessionId: 'sess-5',
        title: 'Z2',
        workingDirectory: undefined,
        existingMasterTaskId: null,
      },
      { sessionRepo: mockSessionRepo },
    );

    expect(mockManager.register).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceUri: '' }),
    );
  });

  it('title 空字符串 → fallback `Session <id-prefix>`', () => {
    const fakeMaster = { id: 'mt-fallback' };
    mockManager.register.mockReturnValue(fakeMaster);

    ensureMasterTaskForSession(
      {
        sessionId: 'sess-abcd1234-rest',
        title: '',
        workingDirectory: '/',
        existingMasterTaskId: null,
      },
      { sessionRepo: mockSessionRepo },
    );

    expect(mockManager.register).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Session sess-abc' }),
    );
  });

  it('title 仅空白 → fallback `Session <id-prefix>`', () => {
    const fakeMaster = { id: 'mt-fb-ws' };
    mockManager.register.mockReturnValue(fakeMaster);

    ensureMasterTaskForSession(
      {
        sessionId: 'session-12345',
        title: '   ',
        workingDirectory: '/',
        existingMasterTaskId: null,
      },
      { sessionRepo: mockSessionRepo },
    );

    expect(mockManager.register).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Session session-' }),
    );
  });

  it('ownerUserId 不传 → 默认 local', () => {
    const fakeMaster = { id: 'mt-owner-default' };
    mockManager.register.mockReturnValue(fakeMaster);

    ensureMasterTaskForSession(
      {
        sessionId: 'sess-6',
        title: 'T',
        workingDirectory: '/',
        existingMasterTaskId: null,
      },
      { sessionRepo: mockSessionRepo },
    );

    expect(mockManager.register).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'local' }),
    );
  });

  it('ownerUserId 显式传入 → 不被默认值覆盖', () => {
    const fakeMaster = { id: 'mt-owner-explicit' };
    mockManager.register.mockReturnValue(fakeMaster);

    ensureMasterTaskForSession(
      {
        sessionId: 'sess-7',
        title: 'T',
        workingDirectory: '/',
        existingMasterTaskId: null,
        ownerUserId: 'team-alpha',
      },
      { sessionRepo: mockSessionRepo },
    );

    expect(mockManager.register).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'team-alpha' }),
    );
  });

  it('updateMasterTaskId 抛错 → 不冒泡，master 仍正常返回', () => {
    const fakeMaster = { id: 'mt-db-fail' };
    mockManager.register.mockReturnValue(fakeMaster);
    mockSessionRepo.updateMasterTaskId.mockImplementation(() => {
      throw new Error('DB unavailable');
    });

    const result = ensureMasterTaskForSession(
      {
        sessionId: 'sess-8',
        title: 'T8',
        workingDirectory: '/',
        existingMasterTaskId: null,
      },
      { sessionRepo: mockSessionRepo },
    );

    expect(result).toBe(fakeMaster);
    expect(mockManager.attachSession).toHaveBeenCalled();
  });
});
