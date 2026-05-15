import { useCallback, useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type {
  CapabilityCenterInventory,
  CapabilityCenterItem,
  CapabilityKind,
  CapabilityInstallDraftRequest,
  CapabilityRemoveDraftRequest,
  CapabilityToggleRequest,
} from '@shared/contract/capability';
import ipcService from '../services/ipcService';

export interface CapabilityActionResult {
  type: 'success';
  text: string;
}

export interface UseCapabilityInventoryResult {
  inventory: CapabilityCenterInventory | null;
  items: CapabilityCenterItem[];
  loading: boolean;
  error: string | null;
  actionResult: CapabilityActionResult | null;
  actionKey: string | null;
  reload: () => Promise<void>;
  clearActionResult: () => void;
  setEnabled: (item: CapabilityCenterItem, enabled: boolean) => Promise<void>;
  installDraft: (item: CapabilityCenterItem, inputs?: Record<string, string>) => Promise<void>;
  removeDraft: (item: CapabilityCenterItem) => Promise<void>;
}

function getToggleKind(kind: CapabilityKind): CapabilityToggleRequest['kind'] {
  return kind;
}

export function useCapabilityInventory(): UseCapabilityInventoryResult {
  const [inventory, setInventory] = useState<CapabilityCenterInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<CapabilityActionResult | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setActionResult(null);
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
    setActionResult(null);
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
      setActionResult({
        type: 'success',
        text: `${item.name} 已${enabled ? '启用' : '禁用'}`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionKey(null);
    }
  }, []);

  const clearActionResult = useCallback(() => {
    setActionResult(null);
  }, []);

  const installDraft = useCallback(async (item: CapabilityCenterItem, inputs?: Record<string, string>) => {
    setActionKey(item.id);
    setError(null);
    setActionResult(null);
    try {
      const next = await ipcService.invokeDomain<CapabilityCenterInventory>(
        IPC_DOMAINS.CAPABILITY,
        'installDraft',
        {
          id: item.id,
          kind: item.kind,
          ...(inputs ? { inputs } : {}),
        } satisfies CapabilityInstallDraftRequest,
      );
      setInventory(next);
      setActionResult({
        type: 'success',
        text: `${item.name} 草稿已生成`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionKey(null);
    }
  }, []);

  const removeDraft = useCallback(async (item: CapabilityCenterItem) => {
    setActionKey(item.id);
    setError(null);
    setActionResult(null);
    try {
      const next = await ipcService.invokeDomain<CapabilityCenterInventory>(
        IPC_DOMAINS.CAPABILITY,
        'removeDraft',
        {
          id: item.id,
          kind: item.kind,
        } satisfies CapabilityRemoveDraftRequest,
      );
      setInventory(next);
      setActionResult({
        type: 'success',
        text: `${item.name} 草稿已删除`,
      });
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
    actionResult,
    actionKey,
    reload,
    clearActionResult,
    setEnabled,
    installDraft,
    removeDraft,
  };
}
