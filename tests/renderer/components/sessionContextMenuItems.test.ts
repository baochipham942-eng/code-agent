import { describe, expect, it, vi } from 'vitest';
import { pickNativeFile } from '../../../src/renderer/services/tauriPluginFacade';
import {
  buildSessionContextMenuItems,
  type SessionContextMenuDeps,
} from '../../../src/renderer/components/features/sidebar/sessionContextMenuItems';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  pickNativeFile: vi.fn(),
}));

function makeSession(overrides: Partial<SessionWithMeta> = {}): SessionWithMeta {
  return {
    id: 'sess-1',
    title: '会话标题',
    projectId: 'project-1',
    isArchived: false,
    ...overrides,
  } as SessionWithMeta;
}

function installDomainInvoke(invoke: ReturnType<typeof vi.fn>): void {
  (globalThis as unknown as { window?: { domainAPI: { invoke: typeof invoke } } }).window = {
    domainAPI: { invoke },
  };
}

function makeDeps(overrides: Partial<SessionContextMenuDeps> = {}): SessionContextMenuDeps {
  return {
    pinnedSessionIds: new Set<string>(),
    savedWorkbenchPresets: [],
    savedWorkbenchRecipes: [],
    setWorkingDirectory: vi.fn(),
    applyWorkbenchPreset: vi.fn(),
    applyWorkbenchRecipe: vi.fn(),
    applySessionWorkbenchPreset: vi.fn(),
    saveWorkbenchPresetFromSession: vi.fn(),
    togglePin: vi.fn(),
    setRenamingId: vi.fn(),
    setRenameValue: vi.fn(),
    canOpenSessionReplay: false,
    handleOpenSessionReplay: vi.fn(),
    handleOpenVoiceAudit: vi.fn(),
    voiceLiveInstalled: true,
    unarchiveSession: vi.fn(),
    archiveSession: vi.fn(),
    softDelete: vi.fn(),
    saveExportToDownloads: vi.fn(),
    reloadSessions: vi.fn(async () => undefined),
    switchSession: vi.fn(async () => undefined),
    locateImportedSession: vi.fn(async () => true),
    findImportedSession: vi.fn(async () => null),
    confirmImportSessionFork: vi.fn(async () => true),
    showActionToast: vi.fn(),
    showSuccessToast: vi.fn(),
    showToast: vi.fn(() => 'toast-id'),
    openRuntimeLogsFolder: vi.fn(async () => true),
    t: zh,
    ...overrides,
  };
}

describe('buildSessionContextMenuItems', () => {
  it('始终包含基础项：置顶/重命名/复制ID/归档/删除/导出', () => {
    const items = buildSessionContextMenuItems(makeSession(), makeDeps());
    const labels = items.map((item) => item.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        '置顶',
        '重命名',
        '复制会话 ID',
        '归档',
        '删除',
        '导出 Markdown',
        '导出这条分支',
        '从文件导入会话',
        '导出会话日志',
        '语音审计',
      ]),
    );
    expect(items.find((item) => item.label === '删除')?.danger).toBe(true);
  });

  it('语音审计入口对所有会话可用并传递目标会话', () => {
    const handleOpenVoiceAudit = vi.fn();
    const session = makeSession();
    const items = buildSessionContextMenuItems(session, makeDeps({ handleOpenVoiceAudit }));
    items.find((item) => item.label === '语音审计')?.onClick();
    expect(handleOpenVoiceAudit).toHaveBeenCalledWith(session);
  });

  it('未安装 voice-live 时不提供语音审计入口', () => {
    const items = buildSessionContextMenuItems(makeSession(), makeDeps({ voiceLiveInstalled: false }));
    expect(items.some((item) => item.label === '语音审计')).toBe(false);
  });

  it('非管理员时 Replay 项禁用且文案降级', () => {
    const items = buildSessionContextMenuItems(makeSession(), makeDeps({ canOpenSessionReplay: false }));
    const replay = items.find((item) => item.label === 'Replay 仅管理员可用');
    expect(replay?.disabled).toBe(true);
    expect(items.some((item) => item.label === '打开 Replay')).toBe(false);
  });

  it('管理员时 Replay 项启用且触发 handleOpenSessionReplay', async () => {
    const handleOpenSessionReplay = vi.fn();
    const session = makeSession();
    const items = buildSessionContextMenuItems(
      session,
      makeDeps({ canOpenSessionReplay: true, handleOpenSessionReplay }),
    );
    const replay = items.find((item) => item.label === '打开 Replay');
    expect(replay?.disabled).toBe(false);
    await replay?.onClick();
    expect(handleOpenSessionReplay).toHaveBeenCalledWith(session);
  });

  it('置顶/归档状态反映为切换文案，点击调用对应 store action', () => {
    const togglePin = vi.fn();
    const unarchiveSession = vi.fn();
    const items = buildSessionContextMenuItems(
      makeSession({ isArchived: true }),
      makeDeps({ pinnedSessionIds: new Set(['sess-1']), togglePin, unarchiveSession }),
    );
    expect(items.some((item) => item.label === '取消置顶')).toBe(true);
    const archiveItem = items.find((item) => item.label === '取消归档');
    expect(archiveItem).toBeDefined();
    items.find((item) => item.label === '取消置顶')?.onClick();
    archiveItem?.onClick();
    expect(togglePin).toHaveBeenCalledWith('sess-1');
    expect(unarchiveSession).toHaveBeenCalledWith('sess-1');
  });

  it('最多展示 3 个 Preset 与 3 个 Recipe（slice 截断）', () => {
    const presets = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, context: {} })) as SessionContextMenuDeps['savedWorkbenchPresets'];
    const recipes = Array.from({ length: 4 }, (_, i) => ({ name: `r${i}` })) as SessionContextMenuDeps['savedWorkbenchRecipes'];
    const items = buildSessionContextMenuItems(
      makeSession(),
      makeDeps({ savedWorkbenchPresets: presets, savedWorkbenchRecipes: recipes }),
    );
    expect(items.filter((item) => item.label.startsWith('应用 Preset:')).length).toBe(3);
    expect(items.filter((item) => item.label.startsWith('应用 Recipe:')).length).toBe(3);
  });

  it('导出分支使用 exportSessionFork envelope 并保存 JSON 文件', async () => {
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      data: { schema: 'neo.session-export', version: 3, exportId: 'export-1' },
    });
    installDomainInvoke(invoke);
    const saveExportToDownloads = vi.fn(async () => undefined);
    const showSuccessToast = vi.fn();
    const session = makeSession({ id: 'sess-export' });
    const item = buildSessionContextMenuItems(session, makeDeps({ saveExportToDownloads, showSuccessToast }))
      .find((entry) => entry.label === '导出这条分支');

    await item?.onClick();

    expect(invoke).toHaveBeenCalledWith('domain:session', 'exportSessionFork', expect.objectContaining({
      sessionId: 'sess-export',
      mode: 'subtree',
    }));
    expect(saveExportToDownloads).toHaveBeenCalledWith(
      'neo-session-fork-s-export.json',
      expect.stringContaining('"schema": "neo.session-export"'),
      { silent: true },
    );
    expect(showSuccessToast).toHaveBeenCalledWith('已导出到下载文件夹：neo-session-fork-s-export.json');
  });

  it('取消选择导入文件时不调用读取或导入', async () => {
    vi.mocked(pickNativeFile).mockResolvedValueOnce(null);
    const invoke = vi.fn();
    installDomainInvoke(invoke);
    const item = buildSessionContextMenuItems(
      makeSession({ projectId: 'project-1' }),
      makeDeps(),
    ).find((entry) => entry.label === '从文件导入会话');

    await item?.onClick();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('导入默认拒绝跨 project remap，并把后端错误展示给用户', async () => {
    vi.mocked(pickNativeFile).mockResolvedValueOnce('/tmp/session-fork.json');
    const invoke = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        data: JSON.stringify({
          schema: 'neo.session-export',
          version: 3,
          projectId: 'other-project',
          sessions: [{ id: 'source' }],
          messages: [{ id: 'message' }],
        }),
      })
      .mockResolvedValueOnce({
        success: false,
        error: { code: 'PROJECT_SCOPE_MISMATCH', message: 'remap requires explicit approval' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { rootSessionId: 'imported-root', sessionIdMap: { source: 'imported-root' } },
      });
    installDomainInvoke(invoke);
    const showSuccessToast = vi.fn();
    const confirmImportSessionFork = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const switchSession = vi.fn(async () => undefined);
    const item = buildSessionContextMenuItems(
      makeSession({ projectId: 'project-1' }),
      makeDeps({ showSuccessToast, confirmImportSessionFork, switchSession }),
    ).find((entry) => entry.label === '从文件导入会话');

    await item?.onClick();

    expect(invoke).toHaveBeenNthCalledWith(2, 'domain:session', 'importSessionFork', expect.objectContaining({
      targetProjectId: 'project-1',
      allowProjectRemap: false,
    }));
    expect(invoke).toHaveBeenNthCalledWith(3, 'domain:session', 'importSessionFork', expect.objectContaining({
      targetProjectId: 'project-1',
      allowProjectRemap: true,
    }));
    expect(confirmImportSessionFork).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: '确认跨项目导入',
      confirmText: '以当前项目导入',
    }));
    expect(switchSession).toHaveBeenCalledWith('imported-root');
    expect(showSuccessToast).toHaveBeenCalledWith('已导入 1 个会话');
  });

  it('导入文件不是 JSON 时展示解析错误且不调用导入', async () => {
    vi.mocked(pickNativeFile).mockResolvedValueOnce('/tmp/not-a-session.json');
    const invoke = vi.fn().mockResolvedValueOnce({ success: true, data: '{broken' });
    installDomainInvoke(invoke);
    const showActionToast = vi.fn();
    const item = buildSessionContextMenuItems(
      makeSession({ projectId: 'project-1' }),
      makeDeps({ showActionToast }),
    ).find((entry) => entry.label === '从文件导入会话');

    await item?.onClick();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(showActionToast).toHaveBeenCalledWith(
      '所选文件不是有效的 Neo 会话分支文件',
      expect.objectContaining({ label: '选择其他文件' }),
    );
  });

  it('重复导入由后端冲突码回显为错误', async () => {
    vi.mocked(pickNativeFile).mockResolvedValueOnce('/tmp/session-fork.json');
    const invoke = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        data: JSON.stringify({
          schema: 'neo.session-export',
          version: 3,
          exportId: 'export-1',
          projectId: 'project-1',
          sessions: [{ id: 'source' }],
          messages: [{ id: 'message' }],
        }),
      })
      .mockResolvedValueOnce({
        success: false,
        error: { code: 'SYNC_ID_DIGEST_CONFLICT', message: 'export already imported' },
      });
    installDomainInvoke(invoke);
    const showActionToast = vi.fn();
    const locateImportedSession = vi.fn(async () => true);
    const item = buildSessionContextMenuItems(
      makeSession({ projectId: 'project-1' }),
      makeDeps({ showActionToast, locateImportedSession }),
    ).find((entry) => entry.label === '从文件导入会话');

    await item?.onClick();

    expect(showActionToast).toHaveBeenCalledWith(
      '这条会话分支已经导入过了',
      expect.objectContaining({ label: '刷新会话列表' }),
    );
    const action = showActionToast.mock.calls[0][1] as { onClick: () => void };
    action.onClick();
    await vi.waitFor(() => expect(locateImportedSession).toHaveBeenCalledWith('export-1', 'project-1'));
  });

  it('同一文件再次导入且后端返回原会话时展示已导入文案和刷新动作', async () => {
    vi.mocked(pickNativeFile).mockResolvedValueOnce('/tmp/session-fork.json');
    const invoke = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        data: JSON.stringify({
          schema: 'neo.session-export',
          version: 3,
          exportId: 'export-1',
          payloadDigest: 'digest-1',
          projectId: 'project-1',
          sessions: [{ id: 'source' }],
          messages: [{ id: 'message' }],
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        data: { rootSessionId: 'imported-root', sessionIdMap: { source: 'imported-root' } },
      });
    installDomainInvoke(invoke);
    const showActionToast = vi.fn();
    const showSuccessToast = vi.fn();
    const findImportedSession = vi.fn(async () => ({ id: 'imported-root' }));
    const locateImportedSession = vi.fn(async () => true);
    const item = buildSessionContextMenuItems(
      makeSession({ projectId: 'project-1' }),
      makeDeps({ showActionToast, showSuccessToast, findImportedSession, locateImportedSession }),
    ).find((entry) => entry.label === '从文件导入会话');

    await item?.onClick();

    expect(invoke).toHaveBeenNthCalledWith(2, 'domain:session', 'importSessionFork', expect.objectContaining({
      targetProjectId: 'project-1',
    }));
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(showActionToast).toHaveBeenCalledWith(
      '这条会话分支已经导入过了',
      expect.objectContaining({ label: '刷新会话列表' }),
    );
    const action = showActionToast.mock.calls[0][1] as { onClick: () => void };
    action.onClick();
    await vi.waitFor(() => expect(locateImportedSession).toHaveBeenCalledWith('export-1', 'project-1'));
  });

  it('没有 projectId 的会话不显示导入入口', () => {
    const items = buildSessionContextMenuItems(makeSession({ projectId: undefined }), makeDeps());
    expect(items.some((item) => item.label === '从文件导入会话')).toBe(false);
  });

  const IMPORT_ERROR_CASES = [
    {
      code: 'DIGEST_MISMATCH',
      message: '文件内容与摘要不符，文件可能被改动或损坏',
      action: '重新导出一份',
    },
    {
      code: 'REFERENCE_NOT_CLOSED',
      message: '文件引用不完整，无法导入',
      action: '重新导出一份',
    },
    {
      code: 'ORDINAL_INVALID',
      message: '消息顺序不完整，无法导入',
      action: '重新导出一份',
    },
    {
      code: 'ID_REMAP_COLLISION',
      message: '导入标识冲突，无法写入当前项目',
      action: '重新导出一份',
    },
    {
      code: 'PORTABLE_EVIDENCE_REQUIRED',
      message: '工作区证据不完整，无法导入',
      action: '重新导出一份',
    },
  ] as const;

  it.each(IMPORT_ERROR_CASES)('导入错误码 $code 展示人话文案和可点动作', async ({ code, message, action }) => {
    vi.mocked(pickNativeFile).mockResolvedValueOnce('/tmp/session-fork.json');
    const invoke = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        data: JSON.stringify({
          schema: 'neo.session-export',
          version: 3,
          exportId: 'export-1',
          projectId: 'project-1',
          sessions: [{ id: 'source' }],
          messages: [{ id: 'message' }],
        }),
      })
      .mockResolvedValueOnce({
        success: false,
        error: { code, message: code },
      });
    installDomainInvoke(invoke);
    const showActionToast = vi.fn();
    const item = buildSessionContextMenuItems(
      makeSession({ projectId: 'project-1' }),
      makeDeps({ showActionToast }),
    ).find((entry) => entry.label === '从文件导入会话');

    await item?.onClick();

    expect(showActionToast).toHaveBeenCalledWith(
      message,
      expect.objectContaining({ label: action }),
    );
  });
});
