// ============================================================================
// AboutSettings - About & Version Info Tab
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useI18n } from '../../../../hooks/useI18n';
import { IPC_CHANNELS } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';

const logger = createLogger('AboutSettings');

// ============================================================================
// Component
// ============================================================================

export const AboutSettings: React.FC = () => {
  const { t } = useI18n();
  const [version, setVersion] = useState<string>('...');

  useEffect(() => {
    const loadVersion = async () => {
      try {
        const v = await ipcService.invoke(IPC_CHANNELS.APP_GET_VERSION);
        if (v) setVersion(v);
      } catch (error) {
        logger.error('Failed to load version', error);
      }
    };
    loadVersion();
  }, []);

  return (
    <div className="space-y-6">
      <WebModeBanner />
      {/* App Icon & Version */}
      <div className="text-center">
        <div className="w-20 h-20 mx-auto rounded-2xl bg-zinc-950 p-[1px] shadow-xl shadow-black/40 mb-4">
          <div className="relative h-full w-full overflow-hidden rounded-2xl bg-[#050506]">
            <div className="absolute inset-0 bg-gradient-to-br from-[#030304] to-[#17191f]" />
            <div className="absolute inset-[18px] bg-zinc-100 [clip-path:polygon(0_100%,0_0,22%_0,78%_65%,78%_0,100%_0,100%_100%,78%_100%,22%_35%,22%_100%)]" />
            <div className="absolute bottom-4 right-4 h-2.5 w-2.5 rounded-full bg-[#29D6A3] shadow-[0_0_0_7px_rgba(41,214,163,0.28)]" />
          </div>
        </div>
        <h3 className="text-xl font-semibold text-zinc-200">Agent Neo</h3>
        <p className="text-sm text-zinc-400 mt-1">{t.about.version} {version}</p>
      </div>

      {/* About Description */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-200 mb-2">{t.about.title}</h4>
        <p className="text-sm text-zinc-400 leading-relaxed">
          {t.about.description}
        </p>
      </div>

      {/* Capabilities */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-200 mb-2">{t.about.capabilities}</h4>
        <div className="flex flex-wrap gap-2">
          {t.about.highlights.map(
            (highlight) => (
              <span
                key={highlight}
                className="px-2 py-1 text-xs rounded bg-zinc-900 text-zinc-400"
              >
                {highlight}
              </span>
            )
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-xs text-zinc-500">
        {t.about.madeWith}
      </div>
    </div>
  );
};
