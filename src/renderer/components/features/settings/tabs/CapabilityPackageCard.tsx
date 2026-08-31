import React from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import type {
  CapabilityPackagePermission,
  InstalledCapabilityPackage,
} from '@shared/contract/capabilityPackage';
import { useAppStore } from '../../../../stores/appStore';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';

export const Pill: React.FC<{
  children: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}> = ({ children, tone = 'default' }) => {
  const toneClass = tone === 'success'
    ? 'border-badge-success/30 bg-emerald-500/10 text-badge-success'
    : tone === 'warning'
      ? 'border-badge-warning/30 bg-amber-500/10 text-badge-warning'
      : tone === 'danger'
        ? 'border-red-500/30 bg-red-500/10 text-badge-danger'
        : 'border-zinc-700 bg-zinc-800 text-zinc-300';

  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] ${toneClass}`}>
      {children}
    </span>
  );
};

interface CapabilityPackageCardProps {
  plugin: InstalledCapabilityPackage;
  busyKey: string | null;
  packageBusy: boolean;
  permissionLabel: (permission: CapabilityPackagePermission) => string;
  onInstall: (plugin: InstalledCapabilityPackage) => void;
  onUninstall: (plugin: InstalledCapabilityPackage) => void;
  onReinstall: () => void;
}

export const CapabilityPackageCard: React.FC<CapabilityPackageCardProps> = ({
  plugin,
  busyKey,
  packageBusy,
  permissionLabel,
  onInstall,
  onUninstall,
  onReinstall,
}) => {
  const { t } = useI18n();
  const pluginsText = t.settings.plugins;
  const setActiveInternalFeature = useAppStore((state) => state.setActiveInternalFeature);
  const busy = busyKey === `capability-package:uninstall:${plugin.id}`;
  const isInternal = plugin.surface === 'internal-feature';
  const isActiveInternal = isInternal && plugin.state === 'active';
  const isFailedInternal = isInternal && plugin.state === 'error';

  return (
    <div
      data-testid={`capability-package-${plugin.id}`}
      className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-zinc-100">{plugin.name}</h4>
            <Pill>{plugin.version}</Pill>
            <Pill tone={plugin.state === 'active' ? 'success' : 'default'}>
              {plugin.state !== 'available' ? t.capabilityPackages.installed : t.capabilityPackages.removed}
            </Pill>
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{plugin.description}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {plugin.permissions.map((permission) => <Pill key={permission}>{permissionLabel(permission)}</Pill>)}
            {isInternal ? (
              <Pill tone="warning">{pluginsText.manualImport.internalFeature}</Pill>
            ) : (
              <Pill>{plugin.toolNames.length}{pluginsText.manualImport.toolsSuffix}</Pill>
            )}
          </div>
          {isActiveInternal ? <p className="mt-2 text-xs text-badge-success">{t.internalFeatures.activeHint}</p> : null}
          {isFailedInternal && plugin.error ? (
            <p className="mt-2 text-xs text-badge-danger">{t.internalFeatures.startErrorPrefix}{plugin.error}</p>
          ) : null}
        </div>

        {plugin.state === 'available' ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onInstall(plugin)}
            loading={packageBusy}
            disabled={busyKey !== null || packageBusy}
            leftIcon={<Download className="h-3.5 w-3.5" />}
          >
            {pluginsText.manualImport.install}
          </Button>
        ) : (
          <div className="flex shrink-0 gap-2">
            {isActiveInternal ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid={`open-internal-feature-${plugin.id}`}
                onClick={() => setActiveInternalFeature(plugin.id)}
              >
                {t.internalFeatures.open}
              </Button>
            ) : null}
            {isFailedInternal ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={onReinstall}
                disabled={busyKey !== null || packageBusy}
                leftIcon={<Upload className="h-3.5 w-3.5" />}
              >
                {t.internalFeatures.reinstall}
              </Button>
            ) : null}
            <Button
              variant="danger"
              size="sm"
              onClick={() => onUninstall(plugin)}
              loading={busy}
              disabled={busyKey !== null}
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            >
              {pluginsText.manualImport.uninstall}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
