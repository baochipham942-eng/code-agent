// ============================================================================
// WebModeBanner - 桌面功能降级提示
// ============================================================================

import React from 'react';
import { Monitor } from 'lucide-react';
import { isWebMode } from '../../../utils/platform';
import { useI18n } from '../../../hooks/useI18n';

/**
 * Shows an info banner when running in web mode.
 * Renders nothing in desktop mode.
 */
export const WebModeBanner: React.FC = () => {
  const { t } = useI18n();
  if (!isWebMode()) return null;

  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
      <Monitor className="h-4 w-4 flex-shrink-0" />
      <span>{t.settings.webModeBanner.desktopOnlyFeature}</span>
    </div>
  );
};

/**
 * Inline label for individual controls that require desktop mode.
 */
export const DesktopOnlyLabel: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const { t } = useI18n();
  if (!isWebMode()) return children ? <>{children}</> : null;

  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <span className="text-xs text-gray-400 dark:text-gray-500">{t.settings.webModeBanner.desktopOnlyLabel}</span>
    </span>
  );
};
