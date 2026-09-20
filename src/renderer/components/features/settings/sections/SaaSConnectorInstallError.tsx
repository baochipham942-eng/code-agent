import React from 'react';
import { Link2 } from 'lucide-react';
import { Button } from '../../../primitives';

const INSTALL_ERROR_BADGE_CLASS = 'border border-red-500/25 bg-red-500/15 text-badge-danger';

export function getInstallErrorPresentation(text: {
  badges: { installFailed: string };
  details: { cliInstallFailed: string };
  actions: { reinstall: string };
}): { badge: string; badgeClassName: string; detail: string; actionLabel: string } {
  return {
    badge: text.badges.installFailed,
    badgeClassName: INSTALL_ERROR_BADGE_CLASS,
    detail: text.details.cliInstallFailed,
    actionLabel: text.actions.reinstall,
  };
}

export function saasConnectorDetailToneClass(state: string | undefined): string {
  if (state === 'missing_client_id' || state === 'admin_blocked' || state === 'install_error') {
    return 'border-red-500/25 bg-red-500/10 text-badge-danger';
  }
  if (
    state === 'connecting_step_1'
    || state === 'connecting_step_2'
    || state === 'connecting_single'
  ) {
    return 'border-amber-500/25 bg-amber-500/10 text-badge-warning';
  }
  return 'border-zinc-700 bg-zinc-950/40 text-zinc-400';
}

export function isInstallRepairState(state: string | undefined): state is 'ready' | 'install_error' {
  return state === 'ready' || state === 'install_error';
}

interface SaaSConnectorInstallActionProps {
  providerId: string;
  repair: boolean;
  label: string;
  reinstallLabel: string;
  connectingLabel?: string;
  connecting?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onConnect: () => void;
}

export const SaaSConnectorInstallAction: React.FC<SaaSConnectorInstallActionProps> = ({
  providerId,
  repair,
  label,
  reinstallLabel,
  connectingLabel,
  connecting = false,
  disabled = false,
  loading = false,
  onConnect,
}) => (
  <Button
    size="sm"
    variant="primary"
    loading={loading}
    disabled={disabled}
    onClick={onConnect}
    leftIcon={!connecting ? <Link2 className="h-3 w-3" /> : undefined}
    data-testid={`saas-connect-${providerId}`}
  >
    {connecting ? (connectingLabel ?? reinstallLabel) : repair ? reinstallLabel : label}
  </Button>
);
