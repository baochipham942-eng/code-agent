// ============================================================================
// AppshotsSettings - Appshots 设置 Tab
// 启用开关 / 发送目标会话 / 触发方式说明 / 权限引导
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Camera, Monitor, Accessibility, Check } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { createLogger } from '../../../../utils/logger';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';
import { openNativeDesktopSystemSettings } from '../../../../services/nativeDesktop';
import {
  invokeNativeCommandAction,
  isNativeCommandRuntimeAvailable,
} from '../../../../services/nativeCommandFacade';
import { useI18n } from '../../../../hooks/useI18n';

const logger = createLogger('AppshotsSettings');
const TARGET_SESSION_OPTIONS = ['current', 'new'] as const;

// 把「启用」同步给原生左右 Cmd 热键监听（Tauri command）。
async function syncNativeEnabled(enabled: boolean): Promise<void> {
  if (!isNativeCommandRuntimeAvailable()) return;
  try {
    await invokeNativeCommandAction('setAppshotsEnabled', { enabled });
  } catch (error) {
    logger.error('Failed to sync appshots native enabled state', error);
  }
}

export const AppshotsSettings: React.FC = () => {
  const { t } = useI18n();
  const appshotsText = t.settings.appshots;
  const [enabled, setEnabled] = useState(true);
  const [target, setTarget] = useState<'current' | 'new'>('current');
  const web = isWebMode();

  useEffect(() => {
    (async () => {
      try {
        const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
        const a = settings?.appshots;
        if (a) {
          setEnabled(a.enabled);
          setTarget(a.targetSession);
          await syncNativeEnabled(a.enabled);
        }
      } catch (error) {
        logger.error('Failed to load Appshots settings', error);
      }
    })();
  }, []);

  const persist = async (nextEnabled: boolean, nextTarget: 'current' | 'new') => {
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        appshots: { enabled: nextEnabled, targetSession: nextTarget },
      } as Partial<AppSettings>);
    } catch (error) {
      logger.error('Failed to save Appshots settings', error);
    }
  };

  const handleToggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await persist(next, target);
    await syncNativeEnabled(next);
  };

  const handleTarget = async (next: 'current' | 'new') => {
    setTarget(next);
    await persist(enabled, next);
  };

  return (
    <div className="space-y-6">
      <WebModeBanner />

      {/* 启用开关 */}
      <div className="flex items-center justify-between">
        <div className="pr-4">
          <h3 className="text-sm font-medium text-zinc-200 mb-1">{appshotsText.enableTitle}</h3>
          <p className="text-xs text-zinc-500">
            {appshotsText.enableDescriptionPrefix}
            <strong className="text-zinc-300">{appshotsText.enableDescriptionShortcut}</strong>
            {appshotsText.enableDescriptionSuffix}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={web}
          onClick={handleToggle}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
            enabled ? 'bg-primary-500' : 'bg-zinc-600'
          }`}
        >
          <span
            className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* 触发方式（固定手势，只读说明）*/}
      <div className="pt-4 border-t border-zinc-700">
        <h3 className="text-sm font-medium text-zinc-200 mb-2">{appshotsText.triggerTitle}</h3>
        <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2.5">
          <Camera className="w-4 h-4 text-zinc-400 shrink-0" />
          <span className="text-sm text-zinc-300">{appshotsText.triggerText}</span>
          <kbd className="ml-auto rounded bg-zinc-700 px-2 py-0.5 text-xs text-zinc-300">⌘ + ⌘</kbd>
        </div>
      </div>

      {/* 发送目标 */}
      <div className="pt-4 border-t border-zinc-700">
        <h3 className="text-sm font-medium text-zinc-200 mb-2">{appshotsText.targetTitle}</h3>
        <p className="text-xs text-zinc-500 mb-4">{appshotsText.targetDescription}</p>
        <div className="grid grid-cols-2 gap-3">
          {TARGET_SESSION_OPTIONS.map((option) => {
            const active = target === option;
            const optionText = appshotsText.targetOptions[option];
            return (
              <button
                key={option}
                disabled={web}
                onClick={() => handleTarget(option)}
                className={`relative p-3 rounded-lg border text-left transition-all disabled:opacity-40 ${
                  active
                    ? 'border-zinc-500 bg-zinc-800/60 ring-1 ring-white/10'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                <div className={`text-sm ${active ? 'text-zinc-200' : 'text-zinc-300'}`}>
                  {optionText.label}
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">{optionText.description}</div>
                {active && (
                  <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-zinc-200 flex items-center justify-center">
                    <Check className="w-2.5 h-2.5 text-zinc-950" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 权限 */}
      <div className="pt-4 border-t border-zinc-700">
        <h3 className="text-sm font-medium text-zinc-200 mb-2">{appshotsText.permissionsTitle}</h3>
        <p className="text-xs text-zinc-500 mb-4">
          {appshotsText.permissionsDescription}
        </p>
        <div className="space-y-2">
          <button
            type="button"
            disabled={web}
            onClick={() => openNativeDesktopSystemSettings('screenCapture')}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800 transition-all disabled:opacity-40 text-left"
          >
            <Monitor className="w-4 h-4 text-zinc-400" />
            <span className="text-sm text-zinc-300">{appshotsText.openScreenCapture}</span>
          </button>
          <button
            type="button"
            disabled={web}
            onClick={() => openNativeDesktopSystemSettings('accessibility')}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800 transition-all disabled:opacity-40 text-left"
          >
            <Accessibility className="w-4 h-4 text-zinc-400" />
            <span className="text-sm text-zinc-300">{appshotsText.openAccessibility}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default AppshotsSettings;
