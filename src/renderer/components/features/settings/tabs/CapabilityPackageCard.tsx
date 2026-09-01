import React from 'react';
import { Blocks, CheckCircle2, Download, PackagePlus, Trash2, Upload } from 'lucide-react';
import type {
  CapabilityPackagePermission,
  InstalledCapabilityPackage,
} from '@shared/contract/capabilityPackage';
import { useAppStore } from '../../../../stores/appStore';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';
import { PluginCard, PluginCardPill } from '../../capabilityHub/PluginCard';
import {
  formatPluginPermissionDescription,
  formatPluginPermissionLabel,
} from '../../capabilityHub/pluginPermissionText';

interface CapabilityPackageCardProps {
  plugin: InstalledCapabilityPackage;
  busyKey: string | null;
  packageBusy: boolean;
  onInstall: (plugin: InstalledCapabilityPackage) => void;
  onUninstall: (plugin: InstalledCapabilityPackage) => void;
  onReinstall: () => void;
}

export const CapabilityPackageCard: React.FC<CapabilityPackageCardProps> = ({
  plugin,
  busyKey,
  packageBusy,
  onInstall,
  onUninstall,
  onReinstall,
}) => {
  const { t } = useI18n();
  const pluginsText = t.settings.plugins;
  const capabilityText = t.capabilityPackages;
  const setActiveInternalFeature = useAppStore((state) => state.setActiveInternalFeature);
  const busy = busyKey === `capability-package:uninstall:${plugin.id}`;
  const isInternal = plugin.surface === 'internal-feature';
  const isPluginUi = plugin.surface === 'ui';
  const isActiveInternal = isInternal && plugin.state === 'active';
  const isFailedRendererPlugin = (isInternal || isPluginUi) && plugin.state === 'error';
  const permissions = plugin.permissions.map((permission) => (
    formatPluginPermissionLabel({ permission }, capabilityText.permissionText)
  ));
  const toolCount = plugin.toolNames.length;
  const status = plugin.state !== 'available' ? t.capabilityPackages.installed : t.capabilityPackages.removed;
  const statusTone = plugin.state === 'active' ? 'active' : isFailedRendererPlugin ? 'warning' : 'inactive';
  const meta = (
    <>
      {plugin.version ? <PluginCardPill>v{plugin.version}</PluginCardPill> : null}
      {isInternal ? <PluginCardPill>{pluginsText.manualImport.internalFeature}</PluginCardPill> : null}
      {toolCount > 0 ? <PluginCardPill>{toolCount}{pluginsText.manualImport.toolsSuffix}</PluginCardPill> : null}
    </>
  );
  const notice = (
    <>
      {isActiveInternal ? (
        <p className="mt-3 text-xs text-badge-success">{t.internalFeatures.activeHint}</p>
      ) : null}
      {isFailedRendererPlugin && plugin.error ? (
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
      meta={meta}
      detailsLabel={capabilityText.detailsLabel}
      details={(
        <div>
          <h4 className="text-xs font-medium text-zinc-200">{capabilityText.permissionsTitle}</h4>
          {plugin.permissions.length === 0 ? (
            <p className="mt-2 text-xs leading-5 text-zinc-500">{pluginsText.manualImport.noPermissions}</p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-xs leading-5 text-zinc-400">
              {plugin.permissions.map((permission: CapabilityPackagePermission) => (
                <li key={permission} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-badge-success" />
                  <span>{formatPluginPermissionDescription({ permission }, capabilityText.permissionText)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
            {isFailedRendererPlugin ? (
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
              variant="ghost"
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
