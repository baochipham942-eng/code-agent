import React, { useEffect, useState } from 'react';
import { useI18n } from '../../../../hooks/useI18n';
import { openNativeDesktopSystemSettings } from '../../../../services/nativeDesktop';
import { getOsNotificationPermission, getOsNotificationPermissionSnapshot } from '../../../../utils/osNotification';
import { Button } from '../../../primitives/Button';

type NotificationPermissionSnapshot = {
  permission: Awaited<ReturnType<typeof getOsNotificationPermission>>;
  platform: string | null;
};

export const NotificationPermissionRow: React.FC = () => {
  const { t } = useI18n();
  const text = t.settings.general.notifications;
  const [snapshot, setSnapshot] = useState<NotificationPermissionSnapshot>({ permission: 'unknown', platform: null });
  const [openSettingsFailed, setOpenSettingsFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const next = await getOsNotificationPermissionSnapshot();
      if (mounted) setSnapshot(next);
    };
    const handleFocus = () => void refresh();
    void refresh();
    window.addEventListener('focus', handleFocus);
    return () => {
      mounted = false;
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  const handleOpenSettings = async () => {
    setOpenSettingsFailed(false);
    try {
      await openNativeDesktopSystemSettings('notifications');
    } catch {
      setOpenSettingsFailed(true);
    }
  };

  if (snapshot.platform !== 'macos') return null;

  const permission = snapshot.permission;
  const status = permission === 'granted'
    ? text.on
    : permission === 'denied'
      ? text.off
      : text.unknown;
  const description = permission === 'granted'
    ? text.onDescription
    : permission === 'denied'
      ? text.offDescription
      : text.unknownDescription;
  const statusClass = permission === 'granted'
    ? 'border-badge-success/30 bg-emerald-500/10 text-badge-success'
    : permission === 'denied'
      ? 'border-badge-danger/30 bg-red-500/10 text-badge-danger'
      : 'border-badge-warning/30 bg-amber-500/10 text-badge-warning';

  return (
    <div
      className="flex items-start justify-between gap-4 rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-4"
      data-testid="notification-permission-row"
      data-permission={permission}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-medium text-zinc-200">{text.title}</h4>
          <span
            className={`rounded border px-2 py-0.5 text-xs ${statusClass}`}
            data-testid="notification-permission-status"
          >
            {status}
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-zinc-500">{description}</p>
        {openSettingsFailed ? (
          <p className="mt-1 text-xs leading-5 text-badge-danger" role="alert">{text.openSettingsFailed}</p>
        ) : null}
      </div>
      {permission !== 'granted' ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => void handleOpenSettings()}
        >
          {text.openSettings}
        </Button>
      ) : null}
    </div>
  );
};
