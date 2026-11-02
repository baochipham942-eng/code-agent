// ============================================================================
// CronWebhookLinkCard — Webhook 链接的一次性展示卡（N-CRON-WEBHOOK-CLOUD-HOOK-FU1）
// 创建后与「重新生成」后共用：完整 URL 只在这张卡里出现一次（Copy + 密码级警示），
// 关掉即丢弃，不进任何持久状态。失败也在这里显式说明（云端未配置给本地化引导），
// 绝不静默。
// ============================================================================

import React, { useState } from 'react';
import { Check, Copy, Link2 } from 'lucide-react';
import { Button } from '../../primitives/Button';
import { Input } from '../../primitives/Input';
import { useI18n } from '../../../hooks/useI18n';
import { CronHookError } from '../../../services/cronClient';
import { copyPathToClipboard } from '../../../utils/platform';

const CLOUD_NOT_CONFIGURED_CODE = 'CRON_CLOUD_NOT_CONFIGURED';

/** hook 注册/轮换失败 → 本地化文案：云端未配置给引导句，其余带主机原文（不含密钥）。 */
export function webhookHookFailureText(error: unknown, failureTitle: string, unconfigured: string): string {
  if (error instanceof CronHookError && error.code === CLOUD_NOT_CONFIGURED_CODE) return unconfigured;
  const detail = error instanceof Error ? error.message : String(error);
  return `${failureTitle}: ${detail}`;
}

interface CronWebhookLinkCardProps {
  /** 一次性完整链接；失败时为空。 */
  url?: string;
  /** 失败说明（已本地化）。 */
  failure?: string;
  /** 补充提示（如「旧链接已失效」）。 */
  notice?: string;
  onRetry?: () => void;
  retrying?: boolean;
  onDone: () => void;
}

export const CronWebhookLinkCard: React.FC<CronWebhookLinkCardProps> = ({
  url, failure, notice, onRetry, retrying, onDone,
}) => {
  const { t } = useI18n();
  const wc = t.cronCenter.webhook;
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!url) return;
    if (await copyPathToClipboard(url)) setCopied(true);
  };

  return (
    <div className="space-y-3" data-testid="cron-webhook-link-card">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
        <Link2 className="h-4 w-4 text-badge-info" />
        {wc.cardTitle}
      </div>
      {url && (
        <>
          <label className="block space-y-1.5 text-xs text-zinc-400">
            <span>{wc.cardUrlLabel}</span>
            <Input readOnly value={url} inputSize="sm" className="font-mono" data-testid="cron-webhook-url" onFocus={(event) => event.currentTarget.select()} />
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void handleCopy()} leftIcon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} data-testid="cron-webhook-copy">
              {copied ? wc.copied : wc.copy}
            </Button>
          </div>
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-badge-warning" data-testid="cron-webhook-warning">
            {wc.cardWarning}
          </p>
        </>
      )}
      {notice && <p className="text-xs text-badge-success" data-testid="cron-webhook-notice">{notice}</p>}
      {failure && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-badge-danger" data-testid="cron-webhook-failure">
          {failure}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {failure && onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying} data-testid="cron-webhook-retry">
            {wc.retry}
          </Button>
        )}
        <Button size="sm" onClick={onDone} data-testid="cron-webhook-done">
          {wc.cardDone}
        </Button>
      </div>
    </div>
  );
};
