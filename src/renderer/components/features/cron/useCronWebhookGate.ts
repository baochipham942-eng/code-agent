import type { CronJobDraft } from './types';
import { useCronCloudConfig } from './useCronCloudConfig';
import { stashCronEditorDraft } from './cronEditorDraftStash';
import { openCloudCronSettings } from '../../../utils/cronCloudSettingsNavigation';

/**
 * Webhook 投递的创建门：云端服务没配置时不许建（host 会抛英文原文）；已落库任务
 * （带原绑定）不受限。「去设置」前先暂存草稿，回来由编辑器取回。
 */
export function useCronWebhookGate(draft: CronJobDraft) {
  const cloud = useCronCloudConfig();
  const gated = draft.scheduleType === 'event-webhook' && !draft.eventWebhookSource
    && !cloud.loading && !cloud.configured;
  const gotoSettings = () => {
    stashCronEditorDraft(draft);
    openCloudCronSettings();
  };
  return { cloud, gated, gotoSettings };
}
