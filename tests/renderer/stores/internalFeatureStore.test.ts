import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { InstalledCapabilityPackage } from '../../../src/shared/contract/capabilityPackage';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));

import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import {
  initializeInternalFeatureStore,
  useInternalFeatureStore,
} from '../../../src/renderer/internalFeatures/internalFeatureStore';

function plugin(
  id: string,
  state: InstalledCapabilityPackage['state'] = 'active',
  surface: InstalledCapabilityPackage['surface'] = 'internal-feature',
): InstalledCapabilityPackage {
  return {
    id,
    name: id === 'evaluation-center' ? '评测中心' : id,
    version: '1.0.0',
    description: 'fixture',
    permissions: [],
    state,
    surface,
    toolNames: [],
    ...(surface === 'internal-feature' ? {
      internalFeature: {
        id,
        label: id === 'evaluation-center' ? '评测中心' : id,
        sdkVersion: { host: 'host0001', renderer: 'renderer' },
        rendererEntry: 'dist/renderer/index.js',
        rendererStyles: 'dist/renderer/index.css',
        hostEntry: 'dist/host/index.cjs',
        loadedHash: 'package1',
      },
    } : {}),
  };
}

beforeEach(() => {
  invoke.mockReset();
  useAuthStore.setState({ user: null });
  useAppStore.setState({ activeInternalFeatureId: null, language: 'zh' });
  useInternalFeatureStore.setState({ features: [], loadedAt: null });
  useToastStore.setState({ toasts: [] });
});

describe('internalFeatureStore', () => {
  it('非管理员清空本地列表，且不请求管理员 IPC', async () => {
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    useInternalFeatureStore.setState({ features: [plugin('evaluation-center')] });

    await useInternalFeatureStore.getState().refresh();

    expect(invoke).not.toHaveBeenCalled();
    expect(useInternalFeatureStore.getState().features).toEqual([]);
  });

  it('只保留已装载成功的内部插件', async () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
    invoke.mockResolvedValue({
      success: true,
      data: [
        plugin('evaluation-center'),
        plugin('failed-center', 'error'),
        plugin('tool-plugin', 'active', 'tools'),
      ],
    });

    await useInternalFeatureStore.getState().refresh();

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.CAPABILITY_PACKAGE_LIST);
    expect(useInternalFeatureStore.getState().features.map((item) => item.id)).toEqual(['evaluation-center']);
  });

  it('兼容 web bridge 返回的裸数组', async () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
    invoke.mockResolvedValue([plugin('evaluation-center')]);

    await useInternalFeatureStore.getState().refresh();

    expect(useInternalFeatureStore.getState().features).toHaveLength(1);
  });

  it('读取失败时保留上一次成功结果', async () => {
    const previous = plugin('evaluation-center');
    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
    useInternalFeatureStore.setState({ features: [previous], loadedAt: 123 });
    invoke.mockRejectedValue(new Error('bridge down'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await useInternalFeatureStore.getState().refresh();

    expect(useInternalFeatureStore.getState()).toMatchObject({ features: [previous], loadedAt: 123 });
  });

  it('卸载正在打开的插件后关闭页面，并只给一行提示', async () => {
    const installed = plugin('evaluation-center');
    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
    useInternalFeatureStore.setState({ features: [installed] });
    useAppStore.setState({ activeInternalFeatureId: installed.id });
    invoke.mockResolvedValue({ success: true, data: [] });

    await useInternalFeatureStore.getState().refresh();

    expect(useAppStore.getState().activeInternalFeatureId).toBeNull();
    expect(useToastStore.getState().toasts.map((item) => item.message)).toEqual(['评测中心插件已卸载']);
  });

  it('登录身份从普通用户切成管理员时主动刷新', async () => {
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    invoke.mockResolvedValue({ success: true, data: [plugin('evaluation-center')] });
    initializeInternalFeatureStore();
    expect(invoke).not.toHaveBeenCalled();

    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });

    await vi.waitFor(() => expect(useInternalFeatureStore.getState().features).toHaveLength(1));
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.CAPABILITY_PACKAGE_LIST);
  });
});
