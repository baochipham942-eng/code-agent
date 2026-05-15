import { useCallback, useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type {
  CapabilityCenterInventory,
  CapabilityCenterItem,
  CapabilityKind,
  CapabilityInstallDraftRequest,
  CapabilityToggleRequest,
} from '@shared/contract/capability';
import ipcService from '../services/ipcService';

export interface UseCapabilityInventoryResult {
  inventory: CapabilityCenterInventory | null;
  items: CapabilityCenterItem[];
  loading: boolean;
  error: string | null;
  actionKey: string | null;
  reload: () => Promise<void>;
  setEnabled: (item: CapabilityCenterItem, enabled: boolean) => Promise<void>;
  installDraft: (item: CapabilityCenterItem) => Promise<void>;
}

function getToggleKind(kind: CapabilityKind): CapabilityToggleRequest['kind'] {
  return kind;
}

export function useCapabilityInventory(): UseCapabilityInventoryResult {
  const [inventory, setInventory] = useState<CapabilityCenterInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await ipcService.invokeDomain<CapabilityCenterInventory>(
        IPC_DOMAINS.CAPABILITY,
        'list',
      );
      setInventory(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInventory(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const setEnabled = useCallback(async (item: CapabilityCenterItem, enabled: boolean) => {
    setActionKey(item.id);
    setError(null);
    try {
      const next = await ipcService.invokeDomain<CapabilityCenterInventory>(
        IPC_DOMAINS.CAPABILITY,
        'setEnabled',
        {
          id: item.id,
          kind: getToggleKind(item.kind),
          enabled,
        } satisfies CapabilityToggleRequest,
      );
      setInventory(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionKey(null);
    }
  }, []);

  const installDraft = useCallback(async (item: CapabilityCenterItem) => {
    setActionKey(item.id);
    setError(null);
    try {
      const next = await ipcService.invokeDomain<CapabilityCenterInventory>(
        IPC_DOMAINS.CAPABILITY,
        'installDraft',
        {
          id: item.id,
          kind: item.kind,
        } satisfies CapabilityInstallDraftRequest,
      );
      setInventory(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionKey(null);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    inventory,
    items: inventory?.items || [],
    loading,
    error,
    actionKey,
    reload,
    setEnabled,
    installDraft,
  };
}
