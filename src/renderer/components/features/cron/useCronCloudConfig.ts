import { useCallback, useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { invokeDomain } from '../../../services/ipcService';

export interface CronCloudConfigState {
  loading: boolean;
  /** 地址与令牌都已配置（令牌可来自安全存储，或旧版 settings 里的只读遗留值）。 */
  configured: boolean;
  baseUrl: string;
  /** 打码后的令牌；未配置为空串。 */
  maskedToken: string;
  reload: () => Promise<void>;
}

/** 云端计划任务服务的配置状态：设置卡与 webhook 创建门共用同一份读取。 */
export function useCronCloudConfig(): CronCloudConfigState {
  const [state, setState] = useState({ loading: true, baseUrl: '', maskedToken: '', legacyToken: false });

  const reload = useCallback(async () => {
    try {
      const [settings, keys] = await Promise.all([
        invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get'),
        invokeDomain<Record<string, string | undefined>>(IPC_DOMAINS.SETTINGS, 'getAllServiceKeys'),
      ]);
      setState({
        loading: false,
        baseUrl: settings?.cronCloud?.baseUrl?.trim() ?? '',
        maskedToken: keys?.['neo-cron-cloud'] ?? '',
        legacyToken: Boolean(settings?.cronCloud?.token?.trim()),
      });
    } catch {
      setState((current) => ({ ...current, loading: false }));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return {
    loading: state.loading,
    configured: Boolean(state.baseUrl && (state.maskedToken || state.legacyToken)),
    baseUrl: state.baseUrl,
    maskedToken: state.maskedToken,
    reload,
  };
}
