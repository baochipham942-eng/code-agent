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
      icon: <CheckCircle className="w-4 h-4 text-green-400" />,
      label: statusText.connected,
      color: 'text-green-400',
      dot: 'bg-green-400',
    },
    disconnected: {
      icon: <XCircle className="w-4 h-4 text-red-400" />,
      label: statusText.disconnected,
      color: 'text-red-400',
      dot: 'bg-red-400',
    },
    connecting: {
      icon: <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />,
      label: statusText.connecting,
      color: 'text-yellow-400',
      dot: 'bg-yellow-400',
    },
    error: {
      icon: <XCircle className="w-4 h-4 text-red-400" />,
      label: statusText.error,
      color: 'text-red-400',
      dot: 'bg-red-400',
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
