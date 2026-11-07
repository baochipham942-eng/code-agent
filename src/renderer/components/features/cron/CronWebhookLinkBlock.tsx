// ============================================================================
// CronWebhookLinkBlock — 任务详情里的「Webhook 链接」块（N-CRON-WEBHOOK-CLOUD-HOOK-FU1）
// 完整链接创建时只显示过一次，详情里不再有：这里说明已隐藏、提供带确认的「重新生成」
// （调 rotate，旧链接立刻失效，新链接走同一张一次性卡），任务停用时说明链接已吊销。
// ============================================================================

import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { CronJobDefinition } from '@shared/contract';
import { Button } from '../../primitives/Button';
import { ConfirmDialog } from '../../composites/ConfirmDialog';
import { useI18n } from '../../../hooks/useI18n';
import { cronClient } from '../../../services/cronClient';
import { CronWebhookLinkCard, webhookHookFailureText } from './CronWebhookLinkCard';

export const CronWebhookLinkBlock: React.FC<{ job: CronJobDefinition }> = ({ job }) => {
  const { t } = useI18n();
  const wc = t.cronCenter.webhook;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ url?: string; failure?: string } | null>(null);

  const regenerate = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      setIssued({ url: (await cronClient.rotateWebhookHook(job.id)).url });
    } catch (error) {
      setIssued({ failure: webhookHookFailureText(error, wc.regenerateFailed, wc.unconfigured) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-4" data-testid="cron-webhook-link-block">
      {issued ? (
        <CronWebhookLinkCard
          url={issued.url}
          failure={issued.failure}
          notice={issued.url ? wc.regeneratedNotice : undefined}
          onRetry={() => setConfirming(true)}
          retrying={busy}
          onDone={() => setIssued(null)}
        />
      ) : (
        <>
          <div className="text-sm font-medium text-zinc-200">{wc.blockTitle}</div>
          {job.enabled ? (
            <>
              <p className="mt-1 text-xs leading-5 text-zinc-500" data-testid="cron-webhook-hidden">{wc.blockHidden}</p>
              <Button
                className="mt-3"
                size="sm"
                variant="secondary"
                leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                loading={busy}
                onClick={() => setConfirming(true)}
                data-testid="cron-webhook-regenerate"
              >
                {wc.regenerate}
              </Button>
            </>
          ) : (
            <p className="mt-1 text-xs leading-5 text-zinc-500" data-testid="cron-webhook-revoked">{wc.blockRevoked}</p>
          )}
        </>
      )}
      <ConfirmDialog
        isOpen={confirming}
        title={wc.confirmTitle}
        message={wc.confirmBody}
        variant="warning"
        confirmText={wc.confirmAction}
        onConfirm={() => void regenerate()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
};
