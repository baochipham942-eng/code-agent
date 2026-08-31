import { create } from 'zustand';
import { IPC_CHANNELS } from '@shared/ipc';
import type { InstalledCapabilityPackage } from '@shared/contract/capabilityPackage';
import ipcService from '../services/ipcService';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { canAccessFeature } from '../utils/accessControl';
import { languages } from '../i18n';
import { toast } from '../hooks/useToast';

interface InternalFeatureState {
  features: InstalledCapabilityPackage[];
  loadedAt: number | null;
  refresh: () => Promise<void>;
}

function packageList(result: unknown): InstalledCapabilityPackage[] {
  if (Array.isArray(result)) return result as InstalledCapabilityPackage[];
  const envelope = result as {
    success?: boolean;
    data?: InstalledCapabilityPackage[];
    error?: string;
  } | null | undefined;
  if (!envelope?.success || !Array.isArray(envelope.data)) {
    throw new Error(envelope?.error || '插件列表读取失败');
  }
  return envelope.data;
}

function closeRemovedFeature(
  previousFeatures: InstalledCapabilityPackage[],
  nextFeatures: InstalledCapabilityPackage[],
): void {
  const activeId = useAppStore.getState().activeInternalFeatureId;
  if (!activeId || nextFeatures.some((feature) => feature.id === activeId)) return;

  useAppStore.getState().setActiveInternalFeature(null);
  const removed = previousFeatures.find((feature) => feature.id === activeId);
  if (removed) {
    const t = languages[useAppStore.getState().language].internalFeatures;
    toast.info(`${removed.internalFeature?.label ?? removed.name}${t.unloadedSuffix}`);
  }
}

export const useInternalFeatureStore = create<InternalFeatureState>()((set, get) => ({
  features: [],
  loadedAt: null,
  refresh: async () => {
    const user = useAuthStore.getState().user;
    if (!canAccessFeature('capability.internal', user)) {
      useAppStore.getState().setActiveInternalFeature(null);
      set({ features: [], loadedAt: Date.now() });
      return;
    }

    try {
      const result = await ipcService.invoke(IPC_CHANNELS.CAPABILITY_PACKAGE_LIST);
      const features = packageList(result).filter((feature) => (
        feature.surface === 'internal-feature' && feature.state === 'active'
      ));
      const previousFeatures = get().features;
      set({ features, loadedAt: Date.now() });
      closeRemovedFeature(previousFeatures, features);
    } catch (error) {
      console.warn('[InternalFeatureStore] failed to refresh plugin list', error);
    }
  },
}));

let initialized = false;

export function initializeInternalFeatureStore(): void {
  if (initialized) return;
  initialized = true;
  void useInternalFeatureStore.getState().refresh();
  useAuthStore.subscribe((state, previousState) => {
    const isAdmin = state.user?.isAdmin === true;
    const wasAdmin = previousState.user?.isAdmin === true;
    if (isAdmin !== wasAdmin) void useInternalFeatureStore.getState().refresh();
  });
}
