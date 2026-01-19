// ============================================================================
// AppearanceSettings - Theme & Font Settings Tab
// ============================================================================

import React from 'react';
import { useI18n } from '../../../../hooks/useI18n';
import { Select } from '../../../primitives';

// ============================================================================
// Component
// ============================================================================

export const AppearanceSettings: React.FC = () => {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      {/* Theme Selection */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-4">{t.appearance.theme}</h3>
        <div className="grid grid-cols-3 gap-3">
          {/* Dark Theme - Active */}
          <button className="p-3 rounded-lg border border-blue-500 bg-blue-500/10">
            <div className="w-full h-16 rounded bg-zinc-900 border border-zinc-700 mb-2" />
            <div className="text-sm text-zinc-100">{t.appearance.themes.dark}</div>
          </button>

          {/* Light Theme - Coming Soon */}
          <button className="p-3 rounded-lg border border-zinc-700 opacity-50 cursor-not-allowed">
            <div className="w-full h-16 rounded bg-white border border-zinc-300 mb-2" />
            <div className="text-sm text-zinc-400">{t.appearance.themes.light} ({t.common.coming})</div>
          </button>

          {/* Auto Theme - Coming Soon */}
          <button className="p-3 rounded-lg border border-zinc-700 opacity-50 cursor-not-allowed">
            <div className="w-full h-16 rounded bg-gradient-to-b from-white to-zinc-900 border border-zinc-500 mb-2" />
            <div className="text-sm text-zinc-400">{t.appearance.themes.auto} ({t.common.coming})</div>
          </button>
        </div>
      </div>

      {/* Font Size */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-4">{t.appearance.fontSize}</h3>
        <Select>
          <option value="small">{t.appearance.fontSizes.small}</option>
          <option value="medium">{t.appearance.fontSizes.medium}</option>
          <option value="large">{t.appearance.fontSizes.large}</option>
        </Select>
      </div>
    </div>
  );
};
