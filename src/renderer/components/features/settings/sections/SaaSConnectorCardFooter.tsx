import React from 'react';
import { Button } from '../../../primitives';

interface SaaSConnectorCardFooterProps {
  status: {
    id: string;
    requiresClientSecret: boolean;
    clientSecretConfigured: boolean;
  };
  badge: string;
  text: {
    actions: { cancel: string };
    badges: { connecting: string };
    clientSecretSaved: string;
    metaSeparator: string;
  };
  busy: boolean;
  connecting: boolean;
  onCancel: (providerId: string) => unknown;
}

export const SaaSConnectorCardFooter: React.FC<SaaSConnectorCardFooterProps> = ({
  status,
  badge,
  text,
  busy,
  connecting,
  onCancel,
}) => {
  if (connecting) {
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void onCancel(status.id)}
        data-testid={`saas-cancel-${status.id}`}
        className="mt-3"
      >
        {text.actions.cancel}
      </Button>
    );
  }

  return (
    <div className={`mt-3 text-[11px] ${busy ? 'text-badge-warning' : 'text-zinc-500'}`}>
      {busy ? text.badges.connecting : badge}
      {status.requiresClientSecret && status.clientSecretConfigured
        ? `${text.metaSeparator}${text.clientSecretSaved}`
        : ''}
    </div>
  );
};
