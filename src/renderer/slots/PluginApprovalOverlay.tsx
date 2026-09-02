import React, { useCallback, useEffect, useState } from 'react';
import type { CapabilityPackagePreview } from '@shared/contract/capabilityPackage';
import { IPC_CHANNELS } from '@shared/ipc';
import { PluginInstallDisclosure } from '../components/features/settings/tabs/PluginInstallDisclosure';
import { useI18n } from '../hooks/useI18n';
import ipcService from '../services/ipcService';
import { refreshThirdPartyPluginUi } from './thirdPartyPluginUiLoader';

export const PLUGIN_APPROVAL_REFRESH_EVENT = 'neo-plugin-approval-refresh';
export const PLUGIN_APPROVAL_COMPLETED_EVENT = 'neo-plugin-approval-completed';

export const PluginApprovalOverlay: React.FC = () => {
  const { t } = useI18n();
  const [pending, setPending] = useState<CapabilityPackagePreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await ipcService.invoke(IPC_CHANNELS.CAPABILITY_PACKAGE_APPROVAL_LIST);
    if (result?.success) setPending(Array.isArray(result.data) ? result.data : []);
  }, []);

  useEffect(() => {
    void refresh();
    const handleRefresh = () => { void refresh(); };
    window.addEventListener(PLUGIN_APPROVAL_REFRESH_EVENT, handleRefresh);
    const interval = window.setInterval(handleRefresh, 1_000);
    return () => {
      window.removeEventListener(PLUGIN_APPROVAL_REFRESH_EVENT, handleRefresh);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const preview = pending[0] ?? null;
  const finish = useCallback(async (
    action: () => Promise<unknown>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action() as {
        success?: boolean;
        error?: string;
        data?: { surface?: string };
      } | undefined;
      if (!result?.success) throw new Error(result?.error || '插件授权操作失败');
      if (result.data?.surface === 'ui') await refreshThirdPartyPluginUi();
      await refresh();
      window.dispatchEvent(new Event(PLUGIN_APPROVAL_COMPLETED_EVENT));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div className="pointer-events-auto" data-testid="plugin-approval-overlay">
      {error ? (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-lg border border-red-500/30 bg-zinc-950 px-4 py-3 text-sm text-badge-danger">
          {error}
        </div>
      ) : null}
      <PluginInstallDisclosure
        busy={busy}
        onCancel={() => {
          if (!preview) return;
          void finish(() => ipcService.invoke(IPC_CHANNELS.CAPABILITY_PACKAGE_REJECT, preview.token));
        }}
        onConfirm={(approveFutureVersions) => {
          if (!preview) return;
          void finish(() => ipcService.invoke(
            IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM,
            preview.token,
            approveFutureVersions,
          ));
        }}
        preview={preview}
        text={t.settings.plugins.manualImport}
      />
    </div>
  );
};
