// ============================================================================
// AboutSettings - About & Version Info Tab
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Cpu } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { IPC_CHANNELS } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';

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
        const v = await window.electronAPI?.invoke(IPC_CHANNELS.APP_GET_VERSION);
        if (v) setVersion(v);
      } catch (error) {
        logger.error('Failed to load version', error);
      }
    };
    loadVersion();
  }, []);

  return (
    <div className="space-y-6">
      {/* App Icon & Version */}
      <div className="text-center">
        <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-4">
          <Cpu className="w-10 h-10 text-white" />
        </div>
        <h3 className="text-xl font-semibold text-text-primary">Code Agent</h3>
        <p className="text-sm text-text-secondary mt-1">{t.about.version} {version}</p>
      </div>

      {/* About Description */}
      <div className="bg-surface rounded-lg p-4">
        <h4 className="text-sm font-medium text-text-primary mb-2">{t.about.title}</h4>
        <p className="text-sm text-text-secondary leading-relaxed">
          {t.about.description}
        </p>
      </div>

      {/* Technologies */}
      <div className="bg-surface rounded-lg p-4">
        <h4 className="text-sm font-medium text-text-primary mb-2">{t.about.technologies}</h4>
        <div className="flex flex-wrap gap-2">
          {['Electron', 'React', 'TypeScript', 'Tailwind CSS', 'DeepSeek API'].map(
            (tech) => (
              <span
                key={tech}
                className="px-2 py-1 text-xs rounded bg-deep text-text-secondary"
              >
                {tech}
              </span>
            )
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-xs text-text-tertiary">
        {t.about.madeWith}
      </div>
    </div>
  );
};
