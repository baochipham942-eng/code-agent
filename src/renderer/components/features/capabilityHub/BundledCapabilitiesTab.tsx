import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, Mic, Phone, PackagePlus, Trash2, TriangleAlert } from 'lucide-react';
import type { BundledHostCapabilityReadiness } from '@shared/contract/bundledHostCapability';
import { IPC_CHANNELS } from '@shared/ipc';
import { useI18n } from '../../../hooks/useI18n';
import ipcService from '../../../services/ipcService';
import { useBundledCapabilityStore } from '../../../stores/bundledCapabilityStore';
import { Button } from '../../primitives';
import { HubTabHeader } from './HubTabHeader';
import { PluginCard } from './PluginCard';

type VoiceCapabilityId = 'builtin.voice-live' | 'builtin.voice-input';

function permissionName(permission: string): string {
  return permission.split(/[：:]/, 1)[0].trim();
}

export const BundledCapabilitiesTab: React.FC<{ showHeader?: boolean }> = ({ showHeader = true }) => {
  const { t } = useI18n();
  const copy = t.capabilityPackages;
  const inputInstalled = useBundledCapabilityStore((state) => state.installed['builtin.voice-input']);
  const liveInstalled = useBundledCapabilityStore((state) => state.installed['builtin.voice-live']);
  const revision = useBundledCapabilityStore((state) => (
    state.states.find((item) => item.id === 'builtin.voice-input')?.revision ?? 0
  ));
  const refresh = useBundledCapabilityStore((state) => state.refresh);
  const [readiness, setReadiness] = useState<BundledHostCapabilityReadiness | null>(null);
  const [busyId, setBusyId] = useState<VoiceCapabilityId | null>(null);
  const [error, setError] = useState<{ id: VoiceCapabilityId; text: string } | null>(null);

  const loadReadiness = useCallback(async () => {
    try {
      setReadiness(await ipcService.invoke(
        IPC_CHANNELS.CAPABILITY_STATE_READINESS,
        'builtin.voice-input',
      ));
    } catch (readinessError) {
      setReadiness(null);
      setError({
        id: 'builtin.voice-input',
        text: readinessError instanceof Error ? readinessError.message : String(readinessError),
      });
    }
  }, []);

  useEffect(() => {
    void loadReadiness();
  }, [loadReadiness, revision]);

  const changeInstallState = useCallback(async (
    id: VoiceCapabilityId,
    nextInstalled: boolean,
  ) => {
    setBusyId(id);
    setError(null);
    try {
      await ipcService.invoke(
        nextInstalled ? IPC_CHANNELS.CAPABILITY_STATE_INSTALL : IPC_CHANNELS.CAPABILITY_STATE_UNINSTALL,
        id,
      );
      await refresh();
      if (id === 'builtin.voice-input') await loadReadiness();
    } catch (actionError) {
      setError({ id, text: actionError instanceof Error ? actionError.message : String(actionError) });
    } finally {
      setBusyId(null);
    }
  }, [loadReadiness, refresh]);

  const readinessLabel = readiness?.status === 'ready'
    ? copy.readiness.ready
    : readiness?.status === 'fallback'
      ? copy.readiness.fallback
      : copy.readiness.notReady;

  const status = (installed: boolean) => installed ? copy.installed : copy.removed;
  const action = (id: VoiceCapabilityId, installed: boolean) => (
    <Button
      variant={installed ? 'danger' : 'secondary'}
      size="sm"
      loading={busyId === id}
      disabled={busyId !== null}
      leftIcon={installed ? <Trash2 className="h-3.5 w-3.5" /> : <PackagePlus className="h-3.5 w-3.5" />}
      onClick={() => { void changeInstallState(id, !installed); }}
    >
      {installed ? copy.uninstall : copy.install}
    </Button>
  );
  const notice = (id: VoiceCapabilityId, installed: boolean, installPrompt: string) => (
    <>
      {!installed && (
        <div className="mt-3 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-xs text-badge-accent">
          {installPrompt}
        </div>
      )}
      {error?.id === id && (
        <div role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-badge-danger">
          {error.text}
        </div>
      )}
    </>
  );

  return (
    <div data-testid="bundled-capabilities-tab" className="space-y-3">
      {showHeader && <HubTabHeader title={copy.title} />}
      <PluginCard
        testId="voice-live-capability-card"
        icon={<Phone className="h-4 w-4" />}
        name={copy.voiceLive.name}
        status={status(liveInstalled)}
        statusTone={liveInstalled ? 'active' : 'inactive'}
        description={copy.voiceLive.summary}
        permissions={copy.voiceLive.permissions.map(permissionName)}
        action={action('builtin.voice-live', liveInstalled)}
        detailsLabel={copy.detailsLabel}
        notice={notice('builtin.voice-live', liveInstalled, copy.voiceLive.installPrompt)}
        details={(
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <h4 className="text-xs font-medium text-zinc-200">{copy.permissionsTitle}</h4>
              <ul className="mt-2 space-y-1.5 text-xs leading-5 text-zinc-400">
                {copy.voiceLive.permissions.map((permission) => (
                  <li key={permission} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-badge-success" />
                    <span>{permission}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs leading-5 text-zinc-400">
              {copy.voiceLive.optionalAssets}
            </p>
          </div>
        )}
      />
      <PluginCard
        testId="voice-input-capability-card"
        icon={<Mic className="h-4 w-4" />}
        name={copy.voiceInput.name}
        status={status(inputInstalled)}
        statusTone={inputInstalled ? 'active' : 'inactive'}
        description={copy.voiceInput.summary}
        permissions={copy.voiceInput.permissions.map(permissionName)}
        action={action('builtin.voice-input', inputInstalled)}
        detailsLabel={copy.detailsLabel}
        notice={notice('builtin.voice-input', inputInstalled, copy.voiceInput.installPrompt)}
        details={(
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <h4 className="text-xs font-medium text-zinc-200">{copy.permissionsTitle}</h4>
              <ul className="mt-2 space-y-1.5 text-xs leading-5 text-zinc-400">
                {copy.voiceInput.permissions.map((permission) => (
                  <li key={permission} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-badge-success" />
                    <span>{permission}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-medium text-zinc-200">{copy.readinessTitle}</h4>
              <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="flex items-center gap-2 text-xs text-zinc-200">
                  {readiness?.status === 'ready'
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-badge-success" />
                    : <TriangleAlert className="h-3.5 w-3.5 text-badge-warning" />}
                  <span>{readinessLabel}</span>
                </div>
                {readiness?.installCommand && (
                  <div className="mt-2 flex items-start gap-2 rounded-md bg-zinc-900 p-2">
                    <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[11px] text-zinc-400">
                      {readiness.installCommand}
                    </code>
                    <button
                      type="button"
                      aria-label={copy.copyCommand}
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                      onClick={() => { void navigator.clipboard.writeText(readiness.installCommand ?? ''); }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <p className="mt-2 text-[11px] text-zinc-500">{copy.assetsPreserved}</p>
              </div>
            </div>
          </div>
        )}
      />
    </div>
  );
};
