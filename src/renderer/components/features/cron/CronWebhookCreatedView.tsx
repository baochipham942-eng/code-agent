// ============================================================================
// CronWebhookCreatedView — webhook 任务创建成功后的一次性链接视图
// 挂载即向主机注册 hook 并展示完整 URL 一次；失败显式说明并可重试。
// ref 守卫保证 StrictMode 双挂载不会重复注册（每次注册都会作废上一把令牌）。
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { cronClient } from '../../../services/cronClient';
import { CronWebhookLinkCard, webhookHookFailureText } from './CronWebhookLinkCard';

interface CronWebhookCreatedViewProps {
  jobId: string;
  onDone: () => void;
}

export const CronWebhookCreatedView: React.FC<CronWebhookCreatedViewProps> = ({ jobId, onDone }) => {
  const { t } = useI18n();
  const wc = t.cronCenter.webhook;
  const [url, setUrl] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const register = useCallback(async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      setUrl((await cronClient.registerWebhookHook(jobId)).url);
    } catch (error) {
      setFailure(webhookHookFailureText(error, wc.registerFailed, wc.unconfigured));
    } finally {
      setBusy(false);
    }
  }, [jobId, wc.registerFailed, wc.unconfigured]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void register();
  }, [register]);

  return <CronWebhookLinkCard url={url} failure={failure} onRetry={() => void register()} retrying={busy} onDone={onDone} />;
};
