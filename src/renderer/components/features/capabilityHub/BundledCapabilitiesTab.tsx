import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, Mic, Phone, PackagePlus, Trash2, TriangleAlert } from 'lucide-react';
import type { BundledHostCapabilityReadiness } from '@shared/contract/bundledHostCapability';
import { IPC_CHANNELS } from '@shared/ipc';
import { useI18n } from '../../../hooks/useI18n';
import ipcService from '../../../services/ipcService';
import { useBundledCapabilityStore } from '../../../stores/bundledCapabilityStore';
import { Button } from '../../primitives';
import { HubTabHeader } from './HubTabHeader';

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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadReadiness = useCallback(async () => {
    try {
      setReadiness(await ipcService.invoke(
        IPC_CHANNELS.CAPABILITY_STATE_READINESS,
        'builtin.voice-input',
      ));
    } catch (readinessError) {
      setReadiness(null);
      setError(readinessError instanceof Error ? readinessError.message : String(readinessError));
    }
  }, []);

  useEffect(() => {
    void loadReadiness();
  }, [loadReadiness, revision]);

  const changeInstallState = useCallback(async (
    id: 'builtin.voice-live' | 'builtin.voice-input',
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
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusyId(null);
    }
  }, [loadReadiness, refresh]);

  const readinessLabel = readiness?.status === 'ready'
    ? copy.readiness.ready
    : readiness?.status === 'fallback'
      ? copy.readiness.fallback
      : copy.readiness.notReady;

  return (
    <div data-testid="bundled-capabilities-tab" className="space-y-5">
      {showHeader && <HubTabHeader title={copy.title} />}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5" data-testid="voice-live-capability-card">
        <div className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Phone className="h-5 w-5 text-badge-accent" />
              <h2 className="text-base font-semibold text-zinc-100">{copy.voiceLive.name}</h2>
              <span className={`rounded-full px-2 py-0.5 text-xs ${liveInstalled ? 'bg-emerald-500/10 text-badge-success' : 'bg-zinc-800 text-zinc-400'}`}>
                {liveInstalled ? copy.installed : copy.removed}
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">{copy.voiceLive.summary}</p>
          </div>
          <Button
            variant={liveInstalled ? 'ghost' : 'primary'}
            disabled={busyId === 'builtin.voice-live'}
            leftIcon={liveInstalled ? <Trash2 className="h-4 w-4" /> : <PackagePlus className="h-4 w-4" />}
            onClick={() => { void changeInstallState('builtin.voice-live', !liveInstalled); }}
          >
            {liveInstalled ? copy.uninstall : copy.install}
          </Button>
        </div>
        {!liveInstalled && (
          <div className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-sm text-badge-accent">
            {copy.voiceLive.installPrompt}
          </div>
        )}
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">{copy.permissionsTitle}</h3>
            <ul className="mt-3 space-y-2 text-sm text-zinc-400">
              {copy.voiceLive.permissions.map((permission) => (
                <li key={permission} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-badge-success" />
                  <span>{permission}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 text-sm leading-6 text-zinc-400">
            {copy.voiceLive.optionalAssets}
          </p>
        </div>
      </section>
      <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5" data-testid="voice-input-capability-card">
        <div className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Mic className="h-5 w-5 text-badge-accent" />
              <h2 className="text-base font-semibold text-zinc-100">{copy.voiceInput.name}</h2>
              <span className={`rounded-full px-2 py-0.5 text-xs ${inputInstalled ? 'bg-emerald-500/10 text-badge-success' : 'bg-zinc-800 text-zinc-400'}`}>
                {inputInstalled ? copy.installed : copy.removed}
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">{copy.voiceInput.summary}</p>
          </div>
          {inputInstalled ? (
            <Button
              variant="ghost"
              disabled={busyId === 'builtin.voice-input'}
              leftIcon={<Trash2 className="h-4 w-4" />}
              onClick={() => { void changeInstallState('builtin.voice-input', false); }}
            >
              {copy.uninstall}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busyId === 'builtin.voice-input'}
              leftIcon={<PackagePlus className="h-4 w-4" />}
              onClick={() => { void changeInstallState('builtin.voice-input', true); }}
            >
              {copy.install}
            </Button>
          )}
        </div>

        {!inputInstalled && (
          <div className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-sm text-badge-accent">
            {copy.voiceInput.installPrompt}
          </div>
        )}

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">{copy.permissionsTitle}</h3>
            <ul className="mt-3 space-y-2 text-sm text-zinc-400">
              {copy.voiceInput.permissions.map((permission) => (
                <li key={permission} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-badge-success" />
                  <span>{permission}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-medium text-zinc-200">{copy.readinessTitle}</h3>
            <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
              <div className="flex items-center gap-2 text-sm text-zinc-200">
                {readiness?.status === 'ready'
                  ? <CheckCircle2 className="h-4 w-4 text-badge-success" />
                  : <TriangleAlert className="h-4 w-4 text-badge-warning" />}
                <span>{readinessLabel}</span>
              </div>
              {readiness?.installCommand && (
                <div className="mt-3 flex items-start gap-2 rounded-lg bg-zinc-950 p-2">
                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs text-zinc-400">
                    {readiness.installCommand}
                  </code>
                  <button
                    type="button"
                    aria-label={copy.copyCommand}
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                    onClick={() => { void navigator.clipboard.writeText(readiness.installCommand ?? ''); }}
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              )}
              <p className="mt-2 text-xs text-zinc-500">{copy.assetsPreserved}</p>
            </div>
          </div>
        </div>
        {error && (
          <div role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-badge-danger">
            {error}
          </div>
        )}
      </section>
    </div>
  );
};
