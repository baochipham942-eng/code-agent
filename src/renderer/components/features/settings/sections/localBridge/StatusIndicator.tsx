// ============================================================================
// StatusIndicator - Bridge Connection Status Display
// ============================================================================

import React from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

// ============================================================================
// Types
// ============================================================================

interface StatusIndicatorProps {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
}

// ============================================================================
// Component
// ============================================================================

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status }) => {
  const { t } = useI18n();
  const statusText = t.settings.localBridge.status;
  const config = {
    connected: {
      icon: <CheckCircle className="w-4 h-4 text-badge-success" />,
      label: statusText.connected,
      color: 'text-badge-success',
      dot: 'bg-mark-success',
    },
    disconnected: {
      icon: <XCircle className="w-4 h-4 text-badge-danger" />,
      label: statusText.disconnected,
      color: 'text-badge-danger',
      dot: 'bg-mark-danger',
    },
    connecting: {
      icon: <Loader2 className="w-4 h-4 text-badge-warning animate-spin" />,
      label: statusText.connecting,
      color: 'text-badge-warning',
      dot: 'bg-mark-warning',
    },
    error: {
      icon: <XCircle className="w-4 h-4 text-badge-danger" />,
      label: statusText.error,
      color: 'text-badge-danger',
      dot: 'bg-mark-danger',
    },
  };

  const { icon, label, color } = config[status];

  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className={`text-sm font-medium ${color}`}>{label}</span>
      <span className="text-xs text-zinc-500">localhost:9527</span>
    </div>
  );
};
