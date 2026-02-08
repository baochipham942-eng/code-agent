// ============================================================================
// useErrorRecovery - Hook for receiving error recovery events from main process
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import type { Alert } from '../components/AlertBanner';

export interface ErrorRecoveryEvent {
  errorCode: string;
  userMessage: string;
  recoveryAction: string;
  recoveryStatus: 'pending' | 'in_progress' | 'succeeded' | 'failed';
  timestamp: number;
}

export function useErrorRecovery(maxAlerts = 5) {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.on) return;

    const handler = (_event: any, data: ErrorRecoveryEvent) => {
      const alert: Alert = {
        id: `recovery-${data.timestamp}`,
        level: data.recoveryStatus === 'succeeded' ? 'info'
          : data.recoveryStatus === 'failed' ? 'error'
          : 'warning',
        title: data.errorCode.replace(/_/g, ' '),
        message: data.userMessage,
        timestamp: data.timestamp,
        dismissible: true,
      };

      setAlerts(prev => {
        const updated = [alert, ...prev.filter(a => a.id !== alert.id)];
        return updated.slice(0, maxAlerts);
      });

      // Auto-dismiss succeeded alerts after 5s
      if (data.recoveryStatus === 'succeeded') {
        setTimeout(() => {
          setAlerts(prev => prev.filter(a => a.id !== alert.id));
        }, 5000);
      }
    };

    const cleanup = api.on('error:recovery', handler);
    return () => { if (cleanup) cleanup(); };
  }, [maxAlerts]);

  const dismissAlert = useCallback((id: string) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  }, []);

  return { alerts, dismissAlert };
}
