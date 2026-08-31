import React from 'react';
import { Blocks, Download, PackagePlus, Trash2, Upload } from 'lucide-react';
import type {
  CapabilityPackagePermission,
  InstalledCapabilityPackage,
} from '@shared/contract/capabilityPackage';
import { useAppStore } from '../../../../stores/appStore';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';
import { PluginCard } from '../../capabilityHub/PluginCard';
import { Pill } from './PluginsSettings.ui';

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
  const permissions = [
    ...plugin.permissions.map(permissionLabel),
    isInternal
      ? pluginsText.manualImport.internalFeature
      : `${plugin.toolNames.length}${pluginsText.manualImport.toolsSuffix}`,
  ];
  const status = plugin.state !== 'available' ? t.capabilityPackages.installed : t.capabilityPackages.removed;
  const statusTone = plugin.state === 'active' ? 'active' : isFailedInternal ? 'warning' : 'inactive';
  const notice = (
    <>
      {isActiveInternal ? (
        <p className="mt-3 text-xs text-badge-success">{t.internalFeatures.activeHint}</p>
      ) : null}
      {isFailedInternal && plugin.error ? (
        <p className="mt-3 text-xs text-badge-danger">{t.internalFeatures.startErrorPrefix}{plugin.error}</p>
      ) : null}
    </>
  );

  return (
    <PluginCard
      testId={`capability-package-${plugin.id}`}
      icon={isInternal ? <Blocks className="h-4 w-4" /> : <PackagePlus className="h-4 w-4" />}
      name={plugin.name}
      status={status}
      statusTone={statusTone}
      description={plugin.description}
      permissions={permissions}
      meta={<Pill>{plugin.version}</Pill>}
      notice={notice}
      action={plugin.state === 'available' ? (
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
    />
  );
};
