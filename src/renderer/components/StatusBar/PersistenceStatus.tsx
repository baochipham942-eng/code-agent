import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { PersistenceHealth } from '@shared/contract';
import {
  fetchWebPersistenceHealth,
  getPersistenceWarningText,
  shouldShowPersistenceWarning,
} from '../../services/persistenceHealth';

const REFRESH_INTERVAL_MS = 30_000;

export function PersistenceStatus() {
  const [health, setHealth] = useState<PersistenceHealth | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const next = await fetchWebPersistenceHealth();
        if (!cancelled) setHealth(next);
      } catch {
        if (!cancelled) setHealth(null);
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!shouldShowPersistenceWarning(health)) return null;

  const warningText = getPersistenceWarningText(health);

  return (
    <span
      className="inline-flex items-center gap-1 text-amber-300"
      title={warningText}
      aria-label={warningText}
    >
      <AlertTriangle size={12} />
      <span>历史未持久化</span>
    </span>
  );
}
