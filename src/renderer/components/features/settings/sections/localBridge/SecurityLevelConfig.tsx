// ============================================================================
// SecurityLevelConfig - Bridge Security Level Configuration
// ============================================================================

import React from 'react';
import { Shield } from 'lucide-react';
import { useLocalBridgeStore } from '../../../../../stores/localBridgeStore';
import { useI18n } from '../../../../../hooks/useI18n';

// ============================================================================
// Component
// ============================================================================

export const SecurityLevelConfig: React.FC = () => {
  const { t } = useI18n();
  const securityText = t.settings.localBridge.security;
  const { securityConfirmL2, setSecurityConfirmL2 } = useLocalBridgeStore();

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <Shield className="w-4 h-4 text-zinc-400" />
        <span className="text-sm font-medium text-zinc-200">{securityText.title}</span>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <span className="text-sm text-zinc-200">{securityText.confirmL2Title}</span>
          <p className="text-xs text-zinc-500">{securityText.confirmL2Description}</p>
        </div>
        <button
          onClick={() => setSecurityConfirmL2(!securityConfirmL2)}
          className={`relative w-9 h-5 rounded-full transition-colors ${
            securityConfirmL2 ? 'bg-indigo-500' : 'bg-zinc-600'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              securityConfirmL2 ? 'translate-x-4' : ''
            }`}
          />
        </button>
      </label>

      <div className="bg-zinc-800 rounded-lg p-3 text-xs text-zinc-400 space-y-1.5">
        <div className="flex items-start gap-2">
          <span className="text-green-400 font-medium flex-shrink-0">{securityText.l1}</span>
          <span>{securityText.l1Description}</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-yellow-400 font-medium flex-shrink-0">{securityText.l2}</span>
          <span>{securityText.l2Description}</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-red-400 font-medium flex-shrink-0">{securityText.l3}</span>
          <span>{securityText.l3Description}</span>
        </div>
      </div>
    </div>
  );
};
