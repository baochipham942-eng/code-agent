// ============================================================================
// AppshotsSettings - Appshots 设置 Tab
// 启用开关 / 发送目标会话 / 触发方式说明 / 权限引导
// ============================================================================

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Camera, Monitor, Accessibility, Check, Keyboard } from 'lucide-react';
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
  type AppshotsHotkeyStatus,
} from '../../../../services/nativeCommandFacade';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppshotsStore } from '../../../../stores/appshotsStore';
import { Toggle } from '../../../primitives/Toggle';
import { Button } from '../../../primitives/Button';

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
  // 快捷键权限行：只读状态查询；老 shell 没有这两条命令时整行隐藏（try/catch）。
  const [hotkeyStatus, setHotkeyStatus] = useState<AppshotsHotkeyStatus | null>(null);
  const [hotkeySupported, setHotkeySupported] = useState(true);
  const [hotkeyRequesting, setHotkeyRequesting] = useState(false);
  // 点过「开启快捷键」后最多轮询 60s（2s 一次）等安装结果；平时不轮询。
  const [hotkeyPollUntil, setHotkeyPollUntil] = useState(0);
  const pollUntilRef = useRef(0);

  const refreshHotkeyStatus = useCallback(async () => {
    if (!isNativeCommandRuntimeAvailable()) return;
    try {
      setHotkeyStatus(await invokeNativeCommandAction('getAppshotsHotkeyStatus'));
    } catch (error) {
      // 不区分错误类型：状态查询失败（含老 shell 未注册该命令）一律收起整行，
      // 带可区分原因，别静默吞掉。
      logger.warn('Appshots hotkey status unavailable, hiding shortcut permission row', {
        error: error instanceof Error ? error.message : String(error),
      });
      setHotkeySupported(false);
    }
  }, []);

  useEffect(() => {
    void refreshHotkeyStatus();
  }, [refreshHotkeyStatus]);

  useEffect(() => {
    pollUntilRef.current = hotkeyPollUntil;
    if (hotkeyPollUntil === 0) return;
    const interval = setInterval(() => {
      void refreshHotkeyStatus();
      if (Date.now() >= pollUntilRef.current) setHotkeyPollUntil(0);
    }, 2000);
    return () => clearInterval(interval);
  }, [hotkeyPollUntil, refreshHotkeyStatus]);

  // 显式请求「输入监控」：系统框只在用户点了这个按钮后才出现（Rust 侧每进程至多问一次）。
  const handleEnableHotkey = async () => {
    if (!isNativeCommandRuntimeAvailable()) return;
    setHotkeyRequesting(true);
    try {
      setHotkeyStatus(await invokeNativeCommandAction('requestAppshotsHotkeyAccess'));
    } catch (error) {
      logger.error('Failed to request appshots hotkey access', error);
    } finally {
      setHotkeyRequesting(false);
      setHotkeyPollUntil(Date.now() + 60_000);
    }
  };

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
    // 同步给捕获链路：store 缓存（renderer 同步读）+ Rust 原子标志（skip 决策无 IPC 竞态）
    useAppshotsStore.getState().setTargetSession(next);
    if (isNativeCommandRuntimeAvailable()) {
      void invokeNativeCommandAction('setAppshotsTargetSession', { newSession: next === 'new' }).catch(() => {});
    }
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
        <Toggle
          size="md"
          checked={enabled}
          disabled={web}
          onChange={() => handleToggle()}
          aria-label={appshotsText.enableTitle}
        />
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
          {/* 第三行：快捷键专属的「输入监控」状态 + 显式开启入口（FB-457：系统框只在这一行的
              按钮被点击后才可能出现；状态查询失败/老 shell 缺命令时整行隐藏） */}
          {hotkeySupported && hotkeyStatus && (
            <div
              data-testid="appshots-hotkey-permission-row"
              className="flex items-center gap-3 p-3 rounded-lg border border-zinc-700"
            >
              <Keyboard className="w-4 h-4 text-zinc-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-zinc-300">{appshotsText.hotkeyTitle}</div>
                <div className="text-xs text-zinc-500 mt-0.5">
                  {appshotsText.hotkeyDescription}
                </div>
              </div>
              <span className="text-xs text-zinc-400 shrink-0">
                {!hotkeyStatus.permissionGranted
                  ? appshotsText.hotkeyStatusOff
                  : hotkeyStatus.tapInstalled
                    ? appshotsText.hotkeyStatusOn
                    : appshotsText.hotkeyStatusNeedsRestart}
              </span>
              {!hotkeyStatus.permissionGranted && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={web}
                  loading={hotkeyRequesting}
                  onClick={() => void handleEnableHotkey()}
                >
                  {appshotsText.hotkeyEnable}
                </Button>
              )}
              {!hotkeyStatus.permissionGranted && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={web}
                  onClick={() => openNativeDesktopSystemSettings('inputMonitoring')}
                >
                  {appshotsText.hotkeyOpenSettings}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AppshotsSettings;
