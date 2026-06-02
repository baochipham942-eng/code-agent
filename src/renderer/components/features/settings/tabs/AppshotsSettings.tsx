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

const logger = createLogger('AppshotsSettings');

// 把「启用」同步给原生左右 Cmd 热键监听（Tauri command）。
async function syncNativeEnabled(enabled: boolean): Promise<void> {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  }).__TAURI_INTERNALS__;
  if (!internals) return;
  try {
    await internals.invoke('appshots_set_enabled', { enabled });
  } catch (error) {
    logger.error('appshots_set_enabled 同步失败', error);
  }
}

export const AppshotsSettings: React.FC = () => {
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
        logger.error('加载 Appshots 设置失败', error);
      }
    })();
  }, []);

  const persist = async (nextEnabled: boolean, nextTarget: 'current' | 'new') => {
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        appshots: { enabled: nextEnabled, targetSession: nextTarget },
      } as Partial<AppSettings>);
    } catch (error) {
      logger.error('保存 Appshots 设置失败', error);
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
          <h3 className="text-sm font-medium text-zinc-200 mb-1">启用应用截图</h3>
          <p className="text-xs text-zinc-500">
            按住<strong className="text-zinc-300"> 左 + 右 Command </strong>抓取当前前台 app 窗口，
            连同窗口文本一起送进输入框。
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
        <h3 className="text-sm font-medium text-zinc-200 mb-2">触发方式</h3>
        <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2.5">
          <Camera className="w-4 h-4 text-zinc-400 shrink-0" />
          <span className="text-sm text-zinc-300">同时按下左右 Command 键</span>
          <kbd className="ml-auto rounded bg-zinc-700 px-2 py-0.5 text-xs text-zinc-300">⌘ + ⌘</kbd>
        </div>
      </div>

      {/* 发送目标 */}
      <div className="pt-4 border-t border-zinc-700">
        <h3 className="text-sm font-medium text-zinc-200 mb-2">发送目标</h3>
        <p className="text-xs text-zinc-500 mb-4">截图发送到哪个会话</p>
        <div className="grid grid-cols-2 gap-3">
          {([
            { id: 'current', label: '当前会话', desc: '贴进正在进行的对话' },
            { id: 'new', label: '每次新建会话', desc: '每张截图开一个新对话' },
          ] as const).map((option) => {
            const active = target === option.id;
            return (
              <button
                key={option.id}
                disabled={web}
                onClick={() => handleTarget(option.id)}
                className={`relative p-3 rounded-lg border text-left transition-all disabled:opacity-40 ${
                  active
                    ? 'border-zinc-500 bg-zinc-800/60 ring-1 ring-white/10'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                <div className={`text-sm ${active ? 'text-zinc-200' : 'text-zinc-300'}`}>
                  {option.label}
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">{option.desc}</div>
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
        <h3 className="text-sm font-medium text-zinc-200 mb-2">系统权限</h3>
        <p className="text-xs text-zinc-500 mb-4">
          应用截图需要「屏幕录制」截窗、「辅助功能」读取窗口文本。若热键无反应，请在系统设置里授权后重启应用。
        </p>
        <div className="space-y-2">
          <button
            type="button"
            disabled={web}
            onClick={() => openNativeDesktopSystemSettings('screenCapture')}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800 transition-all disabled:opacity-40 text-left"
          >
            <Monitor className="w-4 h-4 text-zinc-400" />
            <span className="text-sm text-zinc-300">打开「屏幕录制」权限设置</span>
          </button>
          <button
            type="button"
            disabled={web}
            onClick={() => openNativeDesktopSystemSettings('accessibility')}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800 transition-all disabled:opacity-40 text-left"
          >
            <Accessibility className="w-4 h-4 text-zinc-400" />
            <span className="text-sm text-zinc-300">打开「辅助功能」权限设置</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default AppshotsSettings;
