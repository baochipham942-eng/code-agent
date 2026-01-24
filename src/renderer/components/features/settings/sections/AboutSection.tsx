// ============================================================================
// AboutSection - 关于设置（版本信息、检查更新、技术栈）
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Download, RefreshCw, CheckCircle, AlertCircle, Cpu, ExternalLink } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import type { UpdateInfo } from '@shared/types';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('AboutSection');

// ============================================================================
// Types
// ============================================================================

export interface AboutSectionProps {
  updateInfo: UpdateInfo | null;
  onUpdateInfoChange: (info: UpdateInfo | null) => void;
  onShowUpdateModal: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const AboutSection: React.FC<AboutSectionProps> = ({
  updateInfo,
  onUpdateInfoChange,
  onShowUpdateModal,
}) => {
  const { t } = useI18n();
  const [version, setVersion] = useState<string>('...');
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const checkForUpdates = async () => {
    setIsChecking(true);
    setError(null);
    try {
      const info = await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_CHECK);
      if (info) {
        onUpdateInfoChange(info);
      }
    } catch (err) {
      setError(t.update?.checkError || '检查更新失败');
      logger.error('Update check failed', err);
    } finally {
      setIsChecking(false);
    }
  };

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const technologies = [
    'Electron',
    'React',
    'TypeScript',
    'Tailwind CSS',
    'DeepSeek API',
    'Zustand',
    'SQLite',
  ];

  return (
    <div className="space-y-6">
      {/* App Info */}
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center shadow-lg">
          <Cpu className="w-7 h-7 text-white" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">Code Agent</h3>
          <p className="text-sm text-zinc-400">v{version}</p>
        </div>
      </div>

      {/* Version Check */}
      <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-zinc-100">
            {t.update?.title || '版本更新'}
          </span>
          <Button
            onClick={checkForUpdates}
            loading={isChecking}
            variant="ghost"
            size="sm"
            leftIcon={!isChecking ? <RefreshCw className="w-3.5 h-3.5" /> : undefined}
          >
            {isChecking ? '检查中...' : '检查更新'}
          </Button>
        </div>

        {/* Update Status */}
        {updateInfo && (
          <div className={`p-3 rounded-lg ${
            updateInfo.hasUpdate
              ? 'bg-teal-500/10 border border-teal-500/30'
              : 'bg-emerald-500/10 border border-emerald-500/30'
          }`}>
            {updateInfo.hasUpdate ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <Download className="w-4 h-4 text-teal-400 mt-0.5" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-zinc-100">
                      发现新版本: v{updateInfo.latestVersion}
                    </div>
                    {updateInfo.fileSize && (
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {formatSize(updateInfo.fileSize)}
                      </p>
                    )}
                    {updateInfo.releaseNotes && (
                      <div className="mt-2 p-2 bg-zinc-800/50 rounded text-xs text-zinc-400 max-h-20 overflow-y-auto whitespace-pre-line">
                        {updateInfo.releaseNotes}
                      </div>
                    )}
                  </div>
                </div>
                <Button
                  onClick={onShowUpdateModal}
                  variant="primary"
                  fullWidth
                  size="sm"
                  leftIcon={<Download className="w-4 h-4" />}
                >
                  {t.update?.download || '立即更新'}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-400" />
                <span className="text-sm text-zinc-100">{t.update?.upToDate || '已是最新版本'}</span>
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-2 rounded-lg bg-red-500/10 text-red-400 text-xs mt-3">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Technologies */}
      <div>
        <h4 className="text-sm font-medium text-zinc-100 mb-3">
          {t.about?.technologies || '技术栈'}
        </h4>
        <div className="flex flex-wrap gap-2">
          {technologies.map((tech) => (
            <span
              key={tech}
              className="px-2.5 py-1 text-xs rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50"
            >
              {tech}
            </span>
          ))}
        </div>
      </div>

      {/* Links */}
      <div className="pt-4 border-t border-zinc-800/50">
        <div className="flex items-center gap-4 text-xs">
          <a
            href="https://github.com/anthropics/claude-code"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            GitHub
            <ExternalLink className="w-3 h-3" />
          </a>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500">{t.about?.madeWith || 'Made with love'}</span>
        </div>
      </div>
    </div>
  );
};
