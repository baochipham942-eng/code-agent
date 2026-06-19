import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionContextMenuItems,
  type SessionContextMenuDeps,
} from '../../../src/renderer/components/features/sidebar/sessionContextMenuItems';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

function makeSession(overrides: Partial<SessionWithMeta> = {}): SessionWithMeta {
  return {
    id: 'sess-1',
    title: '会话标题',
    isArchived: false,
    ...overrides,
  } as SessionWithMeta;
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
    unarchiveSession: vi.fn(),
    archiveSession: vi.fn(),
    softDelete: vi.fn(),
    saveExportToDownloads: vi.fn(),
    showToast: vi.fn(() => 'toast-id'),
    openRuntimeLogsFolder: vi.fn(async () => true),
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
        '导出会话日志',
      ]),
    );
    expect(items.find((item) => item.label === '删除')?.danger).toBe(true);
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
});
