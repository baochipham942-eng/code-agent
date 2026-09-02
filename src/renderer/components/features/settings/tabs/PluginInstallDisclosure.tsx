import React from 'react';
import { AlertTriangle, KeyRound, MapPin, ShieldCheck } from 'lucide-react';
import type { CapabilityPackagePreview } from '@shared/contract/capabilityPackage';
import type { UiSlotName } from '@shared/contract/uiSlots';
import { Button, Modal } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';
import { formatPluginPermissionDescription } from '../../capabilityHub/pluginPermissionText';
import type { PluginsSettingsText } from './PluginsSettings.helpers';
import { Pill } from './PluginsSettings.ui';

const LOCATION_COPY_KEYS = {
  'nav.account.item': 'accountMenu',
  'hub.tab': 'capabilityCenterTab',
  'settings.section': 'settingsArea',
  'workspace.page': 'workspacePage',
  'shell.overlay': 'floatingContent',
  'conversation.turnTail': 'conversationEnding',
} as const satisfies Record<UiSlotName, string>;

interface PluginInstallDisclosureProps {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (approveFutureVersions: boolean) => void;
  preview: CapabilityPackagePreview | null;
  text: PluginsSettingsText['manualImport'];
}

export const PluginInstallDisclosure: React.FC<PluginInstallDisclosureProps> = ({
  busy,
  onCancel,
  onConfirm,
  preview,
  text,
}) => {
  const { t } = useI18n();
  const requestedLocations = (preview?.requestedUiSlots ?? []).flatMap((name) => {
    const key = LOCATION_COPY_KEYS[name as UiSlotName];
    return key ? [text.uiLocations.items[key]] : [];
  });

  return (
    <Modal
      isOpen={preview !== null}
      onClose={busy ? undefined : onCancel}
      closeOnBackdropClick={false}
      closeOnEsc={!busy}
      title={text.confirmTitle}
      headerIcon={<ShieldCheck className="h-5 w-5 text-badge-warning" />}
      size="lg"
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2 px-6 py-4">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>{text.cancel}</Button>
          <Button onClick={() => onConfirm(false)} disabled={busy}>{text.confirm}</Button>
          <Button variant="secondary" onClick={() => onConfirm(true)} disabled={busy}>{text.approveFuture}</Button>
        </div>
      )}
    >
      {preview && (
        <div className="space-y-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-100">{preview.name}</h3>
              <Pill>{preview.version}</Pill>
              {preview.surface === 'internal-feature' && (
                <Pill tone="warning">{text.internalFeature}</Pill>
              )}
              {preview.replacesInstalledVersion && (
                <Pill tone="warning">{text.replacePrefix}{preview.replacesInstalledVersion}</Pill>
              )}
            </div>
            <p className="mt-2 text-sm leading-6 text-zinc-400">{preview.description}</p>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="text-xs font-medium text-zinc-300">{text.preInstallCheckTitle}</div>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{preview.sandbox.summary}</p>
          </div>

          <div className={preview.sourceTrust.level === 'signed'
            ? 'rounded-lg border border-badge-success/25 bg-emerald-500/5 p-3'
            : 'rounded-lg border border-red-500/30 bg-red-500/5 p-3'}>
            <div className={preview.sourceTrust.level === 'signed'
              ? 'flex items-center gap-2 text-sm font-medium text-badge-success'
              : 'flex items-center gap-2 text-sm font-medium text-badge-danger'}>
              {preview.sourceTrust.level === 'signed'
                ? <ShieldCheck className="h-4 w-4" />
                : <AlertTriangle className="h-4 w-4" />}
              {preview.sourceTrust.level === 'signed'
                ? text.source.signedTitle
                : text.source.unsignedTitle}
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              {preview.sourceTrust.level === 'signed'
                ? text.source.signedBody
                : text.source.unsignedBody}
            </p>
            {preview.sourceTrust.level === 'signed' ? (
              <div className="mt-2 space-y-1 text-xs text-zinc-400">
                <div>{text.source.publisherLabel}: <span className="text-zinc-200">{preview.sourceLabel}</span></div>
                {preview.sourceTrust.keyId ? (
                  <div className="flex items-center gap-1.5">
                    <KeyRound className="h-3.5 w-3.5" />
                    {text.source.keyLabel}: <span className="font-mono text-zinc-200">{preview.sourceTrust.keyId}</span>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-2">
                <div className="text-xs font-medium text-zinc-300">{text.source.unsignedBlockedTitle}</div>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-zinc-400">
                  {text.source.unsignedBlockedLocations.map((location) => <li key={location}>{location}</li>)}
                </ul>
              </div>
            )}
          </div>

          {preview.requestedUiSlots.length > 0 ? (
            <div>
              <h4 className="text-sm font-medium text-zinc-200">{text.uiLocations.title}</h4>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{text.uiLocations.description}</p>
              <div className="mt-3 space-y-2">
                {requestedLocations.map((location) => (
                  <div key={location} className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-sm text-zinc-300">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                    <span>{location}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {preview.surface === 'ui' ? (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm leading-6 text-zinc-200">
              <div className="font-medium text-badge-danger">{text.sharedAccess.title}</div>
              <p className="mt-1">{text.sharedAccess.body}</p>
            </div>
          ) : null}

          <div>
            <h4 className="text-sm font-medium text-zinc-200">{text.permissionTitle}</h4>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{text.permissionDescription}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {preview.permissions.length === 0 ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs text-zinc-500">
                  {text.noPermissions}
                </div>
              ) : preview.permissions.map((permission) => (
                <div key={permission} className="rounded-lg border border-badge-warning/20 bg-amber-500/5 p-3 text-sm text-zinc-300">
                  {formatPluginPermissionDescription({ permission }, t.capabilityPackages.permissionText)}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg bg-zinc-950/60 p-3 text-xs leading-5 text-zinc-500">
            {text.failureEffect}
          </div>
        </div>
      )}
    </Modal>
  );
};
